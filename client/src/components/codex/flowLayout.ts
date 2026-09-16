import { Graph, layout as runDagreLayout, type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre';
import type {
  FlowDocument,
  FlowModuleNode,
  FlowNodeRole,
} from '../../../../shared/flowMode';

export const FLOW_LAYOUT_VERSION = 2;
export const FLOW_NODE_WIDTH = 280;
export const FLOW_NODE_HEIGHT = 208;

export type FlowDisplayRole = 'start' | 'step' | 'decision' | 'end' | 'destination' | 'support' | 'isolated';

export interface FlowNodeTopology {
  stage: number;
  stageCount: number;
  incoming: number;
  outgoing: number;
  displayRole: FlowDisplayRole;
  isBranch: boolean;
  isMerge: boolean;
}

export interface FlowStage {
  index: number;
  nodeIds: string[];
  label: string;
}

export interface FlowLayoutResult {
  document: FlowDocument;
  topology: Record<string, FlowNodeTopology>;
  stages: FlowStage[];
  startNodeIds: string[];
  endNodeIds: string[];
}

const SUPPORT_KINDS = new Set<FlowModuleNode['kind']>(['database', 'queue', 'container', 'file']);

function countConnections(document: FlowDocument) {
  const incoming = new Map(document.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(document.nodes.map((node) => [node.id, 0]));
  for (const edge of document.edges) {
    if (edge.kind === 'dependency' || edge.kind === 'deploy') continue;
    if (edge.source === edge.target) continue;
    if (outgoing.has(edge.source)) outgoing.set(edge.source, (outgoing.get(edge.source) || 0) + 1);
    if (incoming.has(edge.target)) incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
  }
  return { incoming, outgoing };
}

function roleFromTopology(
  node: FlowModuleNode,
  incoming: number,
  outgoing: number,
  stage: number,
  stageCount: number,
): FlowDisplayRole {
  const explicitRole: Exclude<FlowNodeRole, 'auto'> | null = node.flowRole && node.flowRole !== 'auto'
    ? node.flowRole
    : null;
  if (explicitRole === 'entry') return 'start';
  if (explicitRole === 'exit') return 'end';
  if (explicitRole === 'decision') return 'decision';
  if (explicitRole === 'support') return 'support';
  if (explicitRole === 'step') return 'step';
  if (incoming === 0 && outgoing === 0) return 'isolated';
  if (incoming === 0) return 'start';
  if (outgoing === 0) {
    if (SUPPORT_KINDS.has(node.kind)) return 'destination';
    return 'end';
  }
  if (node.kind === 'decision' || outgoing > 1) return 'decision';
  if (stageCount > 1 && stage === stageCount) return 'destination';
  return 'step';
}

function buildStageMap(document: FlowDocument) {
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const forcedEntries = new Set(document.nodes.filter((node) => node.flowRole === 'entry').map((node) => node.id));
  const adjacency = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of document.edges) {
    if (edge.kind === 'dependency' || edge.kind === 'deploy' || edge.source === edge.target) continue;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || forcedEntries.has(edge.target)) continue;
    adjacency.get(edge.source)?.push(edge.target);
  }

  // Collapse cycles into strongly-connected components before assigning a
  // longest-path rank. Every disconnected entry therefore starts at stage 1,
  // while feedback loops remain together instead of being pushed to a junk row.
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (id: string) => {
    indices.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of adjacency.get(id) || []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    components.push(component);
  };
  for (const node of document.nodes) if (!indices.has(node.id)) visit(node.id);

  const componentByNode = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    component.forEach((id) => componentByNode.set(id, componentIndex));
  });
  const componentOutgoing = new Map(components.map((_, index) => [index, new Set<number>()]));
  const componentIndegree = new Map(components.map((_, index) => [index, 0]));
  for (const [source, targets] of adjacency) {
    const sourceComponent = componentByNode.get(source)!;
    for (const target of targets) {
      const targetComponent = componentByNode.get(target)!;
      if (sourceComponent === targetComponent || componentOutgoing.get(sourceComponent)?.has(targetComponent)) continue;
      componentOutgoing.get(sourceComponent)?.add(targetComponent);
      componentIndegree.set(targetComponent, (componentIndegree.get(targetComponent) || 0) + 1);
    }
  }

  const componentStage = new Map<number, number>();
  const queue = components.map((_, index) => index).filter((index) => (componentIndegree.get(index) || 0) === 0);
  queue.forEach((index) => componentStage.set(index, 1));
  let cursor = 0;
  while (cursor < queue.length) {
    const componentIndex = queue[cursor++];
    const currentStage = componentStage.get(componentIndex) || 1;
    for (const targetComponent of componentOutgoing.get(componentIndex) || []) {
      componentStage.set(targetComponent, Math.max(componentStage.get(targetComponent) || 1, currentStage + 1));
      componentIndegree.set(targetComponent, (componentIndegree.get(targetComponent) || 0) - 1);
      if (componentIndegree.get(targetComponent) === 0) queue.push(targetComponent);
    }
  }

  const stageById = new Map<string, number>();
  for (const node of document.nodes) {
    stageById.set(node.id, componentStage.get(componentByNode.get(node.id)!) || 1);
  }
  return { stageById, stageCount: Math.max(1, ...stageById.values()) };
}

export function describeFlowLayout(document: FlowDocument): FlowLayoutResult {
  const { incoming, outgoing } = countConnections(document);
  const { stageById, stageCount } = buildStageMap(document);
  const topology: Record<string, FlowNodeTopology> = {};
  const stages: FlowStage[] = Array.from({ length: stageCount }, (_, index) => ({
    index: index + 1,
    nodeIds: [],
    label: index === 0 ? 'התחלה' : index === stageCount - 1 ? 'סיום ויעדים' : `שלב ${index + 1}`,
  }));

  for (const node of document.nodes) {
    const stage = stageById.get(node.id) || 1;
    const incomingCount = incoming.get(node.id) || 0;
    const outgoingCount = outgoing.get(node.id) || 0;
    const displayRole = roleFromTopology(node, incomingCount, outgoingCount, stage, stageCount);
    topology[node.id] = {
      stage,
      stageCount,
      incoming: incomingCount,
      outgoing: outgoingCount,
      displayRole,
      isBranch: outgoingCount > 1,
      isMerge: incomingCount > 1,
    };
    stages[stage - 1]?.nodeIds.push(node.id);
  }

  const startNodeIds = document.nodes
    .filter((node) => topology[node.id]?.displayRole === 'start')
    .map((node) => node.id);
  const endNodeIds = document.nodes
    .filter((node) => ['end', 'destination'].includes(topology[node.id]?.displayRole))
    .map((node) => node.id);

  // A closed cycle has no natural zero-degree endpoint. In that case, Dagre's
  // first and last visual ranks remain the clearest honest reading anchors.
  if (document.nodes.length > 0 && startNodeIds.length === 0) {
    for (const id of (stages[0]?.nodeIds || []).slice(0, 1)) {
      topology[id] = { ...topology[id], displayRole: 'start' };
      startNodeIds.push(id);
    }
  }
  if (document.nodes.length > 1 && endNodeIds.length === 0) {
    const fallbackEnd = [...(stages.at(-1)?.nodeIds || []), ...document.nodes.map((node) => node.id)]
      .find((id) => !startNodeIds.includes(id));
    if (fallbackEnd) {
      const id = fallbackEnd;
      topology[id] = { ...topology[id], displayRole: 'end' };
      endNodeIds.push(id);
    }
  }

  return { document, topology, stages: stages.filter((stage) => stage.nodeIds.length > 0), startNodeIds, endNodeIds };
}

export function layoutFlowDocument(document: FlowDocument): FlowLayoutResult {
  if (document.nodes.length === 0) return describeFlowLayout({ ...document, layoutVersion: FLOW_LAYOUT_VERSION });

  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true })
    .setGraph({
      rankdir: document.direction === 'rtl' ? 'RL' : 'LR',
      ranker: 'network-simplex',
      acyclicer: 'greedy',
      align: document.direction === 'rtl' ? 'UR' : 'UL',
      ranksep: 150,
      nodesep: 76,
      edgesep: 30,
      marginx: 80,
      marginy: 96,
    })
    .setDefaultEdgeLabel(() => ({}));

  for (const node of document.nodes) {
    graph.setNode(node.id, { width: FLOW_NODE_WIDTH, height: FLOW_NODE_HEIGHT });
  }
  for (const edge of document.edges) {
    const structural = edge.kind !== 'dependency' && edge.kind !== 'deploy';
    graph.setEdge(edge.source, edge.target, {
      minlen: structural ? 1 : 2,
      weight: structural ? 5 : 1,
    }, edge.id);
  }

  runDagreLayout(graph);
  const nodes = document.nodes.map((node) => {
    const positioned = graph.node(node.id);
    return {
      ...node,
      position: positioned && Number.isFinite(positioned.x) && Number.isFinite(positioned.y)
        ? {
            x: Number(positioned.x) - FLOW_NODE_WIDTH / 2,
            y: Number(positioned.y) - FLOW_NODE_HEIGHT / 2,
          }
        : node.position || { x: 0, y: 0 },
    };
  });
  const laidOut: FlowDocument = {
    ...document,
    layoutVersion: FLOW_LAYOUT_VERSION,
    nodes,
    updatedAt: new Date().toISOString(),
  };
  return describeFlowLayout(laidOut);
}

export function traceFlowPath(document: FlowDocument, selectedNodeId: string | null): Set<string> | null {
  if (!selectedNodeId || !document.nodes.some((node) => node.id === selectedNodeId)) return null;
  const forward = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  const backward = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of document.edges) {
    forward.get(edge.source)?.push(edge.target);
    backward.get(edge.target)?.push(edge.source);
  }
  const visited = new Set<string>([selectedNodeId]);
  const walk = (map: Map<string, string[]>) => {
    const queue = [selectedNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const adjacent of map.get(current) || []) {
        if (visited.has(adjacent)) continue;
        visited.add(adjacent);
        queue.push(adjacent);
      }
    }
  };
  walk(forward);
  walk(backward);
  return visited;
}
