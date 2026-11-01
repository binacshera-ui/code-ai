import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionBoardId, extractDecisionBoardDefinitionsFromText, normalizeDecisionBoardAnswer,
  normalizeDecisionBoardDefinitions, DecisionBoardError } from './decisionBoard.js';

const definitions = { title: 'בחירות', items: [
  { id: 'approval', title: 'לאשר?', kind: 'approval', options: [] },
  { id: 'single', title: 'בחר אחד', kind: 'single', options: [{ id: 'one', label: 'אחד' }, { id: 'two', label: 'שניים' }] },
  { id: 'multiple', title: 'בחר כמה', kind: 'multiple', options: [{ id: 'one', label: 'אחד' }, { id: 'two', label: 'שניים' }] },
  { id: 'text', title: 'מה דעתך?', kind: 'text', options: [] },
] };
test('normalizes bounded definitions and never imports agent-supplied answers', () => {
  const parsed = normalizeDecisionBoardDefinitions({ ...definitions, items: definitions.items.map(item => ({ ...item, answer: { verdict: 'approved' } })) });
  assert.equal(parsed.items.length, 4);
  assert.equal(Object.hasOwn(parsed.items[0], 'answer'), false);
  assert.equal(parsed.items[0].description, '');
});
test('validates each answer kind, options and annotations; multiple choices have stable set order', () => {
  const items = normalizeDecisionBoardDefinitions(definitions).items;
  assert.equal(normalizeDecisionBoardAnswer(items[0], { verdict: 'rejected', optionIds: [], note: 'סיבה' }).verdict, 'rejected');
  assert.deepEqual(normalizeDecisionBoardAnswer(items[1], { verdict: null, optionIds: ['two'], note: '' }).optionIds, ['two']);
  assert.deepEqual(normalizeDecisionBoardAnswer(items[2], { verdict: null, optionIds: ['two', 'one'], note: 'הערה' }).optionIds, ['one', 'two']);
  assert.equal(normalizeDecisionBoardAnswer(items[3], { verdict: null, optionIds: [], note: 'תשובה' }).note, 'תשובה');
  for (const [index, answer] of [
    [0, { verdict: null, optionIds: [], note: '' }], [1, { verdict: null, optionIds: [], note: '' }],
    [1, { verdict: null, optionIds: ['one', 'two'], note: '' }], [2, { verdict: null, optionIds: ['one', 'one'], note: '' }],
    [2, { verdict: null, optionIds: ['missing'], note: '' }], [3, { verdict: null, optionIds: [], note: '' }],
    [3, { verdict: null, optionIds: [], note: 'x'.repeat(4001) }],
  ] as const) assert.throws(() => normalizeDecisionBoardAnswer(items[index], answer), DecisionBoardError);
});
test('refuses prototype-like IDs, duplicate IDs and oversized definition arrays', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', '../escape', '']) assert.throws(() => decisionBoardId(id), DecisionBoardError);
  assert.throws(() => normalizeDecisionBoardDefinitions({ title: 'x', items: [definitions.items[0], definitions.items[0]] }), DecisionBoardError);
  assert.throws(() => normalizeDecisionBoardDefinitions({ title: 'x', items: Array.from({ length: 51 }, (_, i) => ({ ...definitions.items[0], id: 'q' + i })) }), DecisionBoardError);
  assert.throws(() => normalizeDecisionBoardDefinitions({ title: 'x', items: [{ ...definitions.items[1], options: Array.from({ length: 11 }, (_, i) => ({ id: 'o' + i, label: 'x' })) }] }), DecisionBoardError);
});
test('extracts only typed decision fences and ignores malformed agent output', () => {
  const code = JSON.stringify(definitions);
  assert.equal(extractDecisionBoardDefinitionsFromText('```json\n' + code + '\n```').length, 0);
  assert.equal(extractDecisionBoardDefinitionsFromText('```code-ai-decisions\nnot-json\n```').length, 0);
  const result = extractDecisionBoardDefinitionsFromText('Visible prose\n```code-ai-decisions\n' + code + '\n```');
  assert.equal(result.length, 1); assert.equal(result[0].items.length, 4);
});
