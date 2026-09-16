import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyFlowDocument, type FlowDocument, type FlowModuleNode } from '../../../../shared/flowMode';
import { FLOW_LAYOUT_VERSION, layoutFlowDocument, traceFlowPath } from './flowLayout';

function module(id: string, kind: FlowModuleNode['kind'] = 'service'): FlowModuleNode {
  return {
    id,
    title: id,
    summary: '',
    description: '',
    kind,
    ownership: 'repository',
    status: 'active',
    flowRole: 'auto',
    groupId: null,
    technology: '',
    runtime: '',
    repositoryPath: '',
    externalUrl: '',
    tags: [],
    evidence: [],
    position: null,
  };
}

function graph(nodes: FlowModuleNode[], connections: Array<[string, string]>): FlowDocument {
  return {
    ...createEmptyFlowDocument('2026-09-16T00:00:00.000Z'),
    nodes,
    edges: connections.map(([source, target], index) => ({
      id: `edge-${index + 1}`,
      source,
      target,
      label: `${source} אל ${target}`,
      description: '',
      kind: 'request',
    })),
  };
}

test('lays out an RTL architecture from start on the right to end on the left', () => {
  const result = layoutFlowDocument(graph(
    [module('entry', 'ui'), module('api', 'api'), module('worker', 'worker'), module('result', 'ui')],
    [['entry', 'api'], ['api', 'worker'], ['worker', 'result']],
  ));
  const positions = Object.fromEntries(result.document.nodes.map((node) => [node.id, node.position!]));

  assert.ok(positions.entry.x > positions.api.x);
  assert.ok(positions.api.x > positions.worker.x);
  assert.ok(positions.worker.x > positions.result.x);
  assert.equal(result.topology.entry.displayRole, 'start');
  assert.equal(result.topology.result.displayRole, 'end');
  assert.deepEqual(result.stages.map((stage) => stage.index), [1, 2, 3, 4]);
  assert.equal(result.document.layoutVersion, FLOW_LAYOUT_VERSION);
});

test('keeps branches on the same stage without overlapping and marks merges', () => {
  const result = layoutFlowDocument(graph(
    [module('entry'), module('left'), module('right'), module('merge'), module('database', 'database')],
    [['entry', 'left'], ['entry', 'right'], ['left', 'merge'], ['right', 'merge'], ['merge', 'database']],
  ));
  const left = result.document.nodes.find((node) => node.id === 'left')!;
  const right = result.document.nodes.find((node) => node.id === 'right')!;

  assert.equal(result.topology.left.stage, result.topology.right.stage);
  assert.notEqual(left.position?.y, right.position?.y);
  assert.equal(result.topology.entry.isBranch, true);
  assert.equal(result.topology.merge.isMerge, true);
  assert.equal(result.topology.database.displayRole, 'destination');
});

test('cycles still receive stable visual start/end anchors', () => {
  const result = layoutFlowDocument(graph(
    [module('one'), module('two'), module('three')],
    [['one', 'two'], ['two', 'three'], ['three', 'one']],
  ));

  assert.ok(result.startNodeIds.length > 0);
  assert.ok(result.endNodeIds.length > 0);
  for (const node of result.document.nodes) {
    assert.ok(Number.isFinite(node.position?.x));
    assert.ok(Number.isFinite(node.position?.y));
  }
});

test('every disconnected entry starts at stage one and secondary dependencies do not shift it', () => {
  const firstEntry = { ...module('first-entry', 'ui'), flowRole: 'entry' as const };
  const secondEntry = { ...module('second-entry', 'ui'), flowRole: 'entry' as const };
  const document = graph(
    [firstEntry, module('first-api', 'api'), secondEntry, module('second-api', 'api'), module('infra', 'container')],
    [['first-entry', 'first-api'], ['second-entry', 'second-api']],
  );
  document.edges.push({
    id: 'infra-dependency',
    source: 'infra',
    target: 'first-entry',
    label: 'תלות תשתיתית',
    description: '',
    kind: 'dependency',
  });
  const result = layoutFlowDocument(document);

  assert.equal(result.topology['first-entry'].stage, 1);
  assert.equal(result.topology['second-entry'].stage, 1);
  assert.equal(result.topology['first-api'].stage, 2);
  assert.equal(result.topology['second-api'].stage, 2);
  assert.equal(result.topology['first-entry'].displayRole, 'start');
});

test('path focus includes every ancestor and descendant but not unrelated modules', () => {
  const document = graph(
    [module('entry'), module('middle'), module('end'), module('unrelated')],
    [['entry', 'middle'], ['middle', 'end']],
  );
  assert.deepEqual([...traceFlowPath(document, 'middle')!].sort(), ['end', 'entry', 'middle']);
});
