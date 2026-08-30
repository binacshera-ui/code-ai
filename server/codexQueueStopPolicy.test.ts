import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConditionalStopDecisionPrompt,
  buildStoppedTaskContinuationPrompt,
  createCodexQueueStopPolicy,
  normalizeCodexQueueStopPolicy,
  parseConditionalStopDecision,
} from './codexQueueStopPolicy.js';

test('creates normalized hard and conditional stop policies', () => {
  const referenceMs = Date.parse('2026-07-31T08:00:00.000Z');
  const hard = createCodexQueueStopPolicy({
    stopAt: '2026-07-31T09:00:00.000Z',
    mode: 'hard',
    question: 'ignored',
  }, referenceMs);
  assert.equal(hard.mode, 'hard');
  assert.equal(hard.question, null);
  assert.equal(hard.status, 'armed');

  const conditional = createCodexQueueStopPolicy({
    stopAt: '2026-07-31T09:00:00.000Z',
    mode: 'conditional',
    question: '  האם נותרה עוד עבודה מהותית?  ',
  }, referenceMs);
  assert.equal(conditional.question, 'האם נותרה עוד עבודה מהותית?');
  assert.equal(conditional.decisionItemId, null);
  assert.equal(conditional.continuationItemId, null);
});

test('rejects past dates and missing conditional questions', () => {
  const referenceMs = Date.parse('2026-07-31T08:00:00.000Z');
  assert.throws(() => createCodexQueueStopPolicy({
    stopAt: '2026-07-31T07:59:59.000Z',
    mode: 'hard',
  }, referenceMs), /future/);
  assert.throws(() => createCodexQueueStopPolicy({
    stopAt: '2026-07-31T09:00:00.000Z',
    mode: 'conditional',
    question: '   ',
  }, referenceMs), /question/);
});

test('restores persisted policy state without accepting malformed contracts', () => {
  const normalized = normalizeCodexQueueStopPolicy({
    stopAt: '2026-07-31T09:00:00Z',
    mode: 'conditional',
    question: 'להמשיך?',
    status: 'awaiting-decision',
    triggeredAt: '2026-07-31T09:00:01Z',
    decisionItemId: 'decision-1',
  });
  assert.equal(normalized?.status, 'awaiting-decision');
  assert.equal(normalized?.decisionItemId, 'decision-1');
  assert.equal(normalizeCodexQueueStopPolicy({
    stopAt: 'not-a-date',
    mode: 'hard',
  }), null);
});

test('accepts only an exact JSON continue=true decision', () => {
  assert.equal(parseConditionalStopDecision('{"continue":true}'), true);
  assert.equal(parseConditionalStopDecision('```json\n{"continue": true}\n```'), true);
  assert.equal(parseConditionalStopDecision('{"continue":false}'), false);
  assert.equal(parseConditionalStopDecision('{"continue":"yes"}'), false);
  assert.equal(parseConditionalStopDecision('כן {"continue":true}'), false);
  assert.equal(parseConditionalStopDecision('{"continue":true}\nextra'), false);
});

test('decision and continuation prompts preserve the dynamic question and original task', () => {
  const decisionPrompt = buildConditionalStopDecisionPrompt({
    question: 'האם הבדיקות עברו?',
    originalTask: 'בנה את המערכת',
  });
  assert.match(decisionPrompt, /האם הבדיקות עברו\?/);
  assert.match(decisionPrompt, /\{"continue": true\}/);
  assert.match(decisionPrompt, /בנה את המערכת/);

  const continuationPrompt = buildStoppedTaskContinuationPrompt({
    originalTask: 'בנה את המערכת',
    taskHadStarted: true,
  });
  assert.match(continuationPrompt, /Resume from the exact current session/);
  assert.match(continuationPrompt, /בנה את המערכת/);
});
