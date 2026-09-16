export const FLOW_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const FLOW_MAX_NODES = 240;
export const FLOW_MAX_EDGES = 640;
export const FLOW_MAX_MAPS_PER_SESSION = 40;

export const FLOW_NODE_KINDS = [
  'system',
  'ui',
  'api',
  'service',
  'worker',
  'database',
  'queue',
  'container',
  'external',
  'file',
  'decision',
  'person',
  'other',
] as const;

export const FLOW_OWNERSHIP_KINDS = [
  'repository',
  'external',
  'managed',
  'infrastructure',
  'unknown',
] as const;

export const FLOW_NODE_STATUSES = ['active', 'planned', 'risk', 'unknown'] as const;
export const FLOW_NODE_ROLES = ['auto', 'entry', 'step', 'decision', 'exit', 'support'] as const;
export const FLOW_EDGE_KINDS = ['data', 'request', 'event', 'dependency', 'control', 'deploy', 'other'] as const;
export const FLOW_EVIDENCE_KINDS = ['path', 'url', 'runtime', 'note'] as const;

export type FlowNodeKind = typeof FLOW_NODE_KINDS[number];
export type FlowOwnershipKind = typeof FLOW_OWNERSHIP_KINDS[number];
export type FlowNodeStatus = typeof FLOW_NODE_STATUSES[number];
export type FlowNodeRole = typeof FLOW_NODE_ROLES[number];
export type FlowEdgeKind = typeof FLOW_EDGE_KINDS[number];
export type FlowEvidenceKind = typeof FLOW_EVIDENCE_KINDS[number];

export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowEvidence {
  id: string;
  kind: FlowEvidenceKind;
  label: string;
  value: string;
}

export interface FlowModuleNode {
  id: string;
  title: string;
  summary: string;
  description: string;
  kind: FlowNodeKind;
  ownership: FlowOwnershipKind;
  status: FlowNodeStatus;
  flowRole: FlowNodeRole;
  groupId: string | null;
  technology: string;
  runtime: string;
  repositoryPath: string;
  externalUrl: string;
  tags: string[];
  evidence: FlowEvidence[];
  position: FlowPoint | null;
}

export interface FlowConnectionEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  description: string;
  kind: FlowEdgeKind;
}

export interface FlowVisualGroup {
  id: string;
  title: string;
  description: string;
  color: 'sky' | 'mint' | 'violet' | 'rose' | 'amber' | 'slate';
}

export interface FlowDocument {
  schemaVersion: typeof FLOW_DOCUMENT_SCHEMA_VERSION;
  id: string;
  title: string;
  subtitle: string;
  summary: string;
  direction: 'rtl' | 'ltr';
  /** Client layout revision. Missing/zero means that the graph needs a fresh automatic layout. */
  layoutVersion?: number;
  groups: FlowVisualGroup[];
  nodes: FlowModuleNode[];
  edges: FlowConnectionEdge[];
  updatedAt: string;
}

export interface FlowMapSummary {
  id: string;
  title: string;
  subtitle: string;
  nodeCount: number;
  edgeCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastGeneratedAt: string | null;
  source: 'agent' | 'user' | null;
}

export class FlowDocumentValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues[0] || 'מסמך הזרימה אינו תקין.');
    this.name = 'FlowDocumentValidationError';
    this.issues = issues;
  }
}

function text(value: unknown, fallback = '', maxLength = 1200): string {
  const normalized = typeof value === 'string' ? value.trim() : fallback;
  return normalized.slice(0, maxLength);
}

function token(value: unknown, fallback: string, maxLength = 100): string {
  const normalized = text(value, fallback, maxLength)
    .replace(/[^\p{L}\p{N}_.:-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && allowed.includes(value) ? value as T[number] : fallback;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((entry) => text(entry, '', maxLength))
    .filter(Boolean)))
    .slice(0, maxItems);
}

function finitePoint(value: unknown): FlowPoint | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
  return {
    x: Math.max(-100_000, Math.min(100_000, Number(raw.x))),
    y: Math.max(-100_000, Math.min(100_000, Number(raw.y))),
  };
}

export function createEmptyFlowDocument(now = new Date().toISOString()): FlowDocument {
  return {
    schemaVersion: FLOW_DOCUMENT_SCHEMA_VERSION,
    id: 'system-flow',
    title: 'מפת המערכת',
    subtitle: '',
    summary: '',
    direction: 'rtl',
    layoutVersion: 0,
    groups: [],
    nodes: [],
    edges: [],
    updatedAt: now,
  };
}

export function normalizeFlowDocument(input: unknown, now = new Date().toISOString()): FlowDocument {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FlowDocumentValidationError(['מסמך הזרימה חייב להיות אובייקט JSON.']);
  }

  const raw = input as Record<string, unknown>;
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  const issues: string[] = [];

  if (rawNodes.length > FLOW_MAX_NODES) issues.push(`הזרימה מכילה יותר מ־${FLOW_MAX_NODES} מודולים.`);
  if (rawEdges.length > FLOW_MAX_EDGES) issues.push(`הזרימה מכילה יותר מ־${FLOW_MAX_EDGES} חיבורים.`);

  const groupIds = new Set<string>();
  const groups: FlowVisualGroup[] = [];
  for (const [index, entry] of rawGroups.slice(0, 40).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const group = entry as Record<string, unknown>;
    const id = token(group.id, `group-${index + 1}`);
    if (groupIds.has(id)) {
      issues.push(`מזהה הקבוצה ${id} מופיע יותר מפעם אחת.`);
      continue;
    }
    groupIds.add(id);
    groups.push({
      id,
      title: text(group.title, `קבוצה ${index + 1}`, 120),
      description: text(group.description, '', 500),
      color: enumValue(group.color, ['sky', 'mint', 'violet', 'rose', 'amber', 'slate'] as const, 'slate'),
    });
  }

  const nodeIds = new Set<string>();
  const nodes: FlowModuleNode[] = [];
  for (const [index, entry] of rawNodes.slice(0, FLOW_MAX_NODES).entries()) {
    if (!entry || typeof entry !== 'object') {
      issues.push(`מודול מספר ${index + 1} אינו אובייקט.`);
      continue;
    }
    const node = entry as Record<string, unknown>;
    const id = token(node.id, `module-${index + 1}`);
    if (nodeIds.has(id)) {
      issues.push(`מזהה המודול ${id} מופיע יותר מפעם אחת.`);
      continue;
    }
    nodeIds.add(id);
    const groupId = text(node.groupId, '', 100) || null;
    nodes.push({
      id,
      title: text(node.title, `מודול ${index + 1}`, 140),
      summary: text(node.summary, '', 360),
      description: text(node.description, '', 1800),
      kind: enumValue(node.kind, FLOW_NODE_KINDS, 'other'),
      ownership: enumValue(node.ownership, FLOW_OWNERSHIP_KINDS, 'unknown'),
      status: enumValue(node.status, FLOW_NODE_STATUSES, 'active'),
      flowRole: enumValue(node.flowRole, FLOW_NODE_ROLES, 'auto'),
      groupId: groupId && groupIds.has(groupId) ? groupId : null,
      technology: text(node.technology, '', 180),
      runtime: text(node.runtime, '', 260),
      repositoryPath: text(node.repositoryPath, '', 500),
      externalUrl: text(node.externalUrl, '', 800),
      tags: stringList(node.tags, 12, 60),
      evidence: (Array.isArray(node.evidence) ? node.evidence : [])
        .slice(0, 20)
        .flatMap((evidenceEntry, evidenceIndex): FlowEvidence[] => {
          if (!evidenceEntry || typeof evidenceEntry !== 'object') return [];
          const evidence = evidenceEntry as Record<string, unknown>;
          const value = text(evidence.value, '', 900);
          if (!value) return [];
          return [{
            id: token(evidence.id, `${id}-evidence-${evidenceIndex + 1}`),
            kind: enumValue(evidence.kind, FLOW_EVIDENCE_KINDS, 'note'),
            label: text(evidence.label, 'ראיה', 120),
            value,
          }];
        }),
      position: finitePoint(node.position),
    });
  }

  const edgeIds = new Set<string>();
  const edges: FlowConnectionEdge[] = [];
  for (const [index, entry] of rawEdges.slice(0, FLOW_MAX_EDGES).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const edge = entry as Record<string, unknown>;
    const source = token(edge.source, '');
    const target = token(edge.target, '');
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
      issues.push(`חיבור מספר ${index + 1} מפנה למודול שאינו קיים.`);
      continue;
    }
    const id = token(edge.id, `${source}-${target}-${index + 1}`, 160);
    if (edgeIds.has(id)) {
      issues.push(`מזהה החיבור ${id} מופיע יותר מפעם אחת.`);
      continue;
    }
    edgeIds.add(id);
    edges.push({
      id,
      source,
      target,
      label: text(edge.label, '', 140),
      description: text(edge.description, '', 600),
      kind: enumValue(edge.kind, FLOW_EDGE_KINDS, 'other'),
    });
  }

  if (issues.length > 0) throw new FlowDocumentValidationError(issues);

  return {
    schemaVersion: FLOW_DOCUMENT_SCHEMA_VERSION,
    id: token(raw.id, 'system-flow'),
    title: text(raw.title, 'מפת המערכת', 180),
    subtitle: text(raw.subtitle, '', 300),
    summary: text(raw.summary, '', 1400),
    direction: raw.direction === 'ltr' ? 'ltr' : 'rtl',
    layoutVersion: Number.isFinite(raw.layoutVersion)
      ? Math.max(0, Math.min(100, Math.floor(Number(raw.layoutVersion))))
      : 0,
    groups,
    nodes,
    edges,
    updatedAt: text(raw.updatedAt, now, 80) || now,
  };
}

export function extractFlowDocumentsFromText(value: string): FlowDocument[] {
  const documents: FlowDocument[] = [];
  const fencePattern = /```(?:bina-flow|bina_flow|flow-json)\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(value)) !== null) {
    try {
      documents.push(normalizeFlowDocument(JSON.parse(match[1])));
    } catch {
      // A streamed or malformed block must never replace the last valid document.
    }
  }
  return documents;
}

export function stripFlowDocumentBlocks(value: string): string {
  return value
    .replace(/```(?:bina-flow|bina_flow|flow-json)\s*[\s\S]*?```/gi, '\n\n_מפת הזרימה נשמרה בקנבס החזותי של השיחה._')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
