import assert from 'node:assert/strict';
import test from 'node:test';
import { interleaveUserInput } from './userInputTimeline';
import type { CodexUserInputRequest } from '../../../../shared/codexUserInput';
const question = (id: string, at: number) => ({ id, createdAt: new Date(at).toISOString() }) as CodexUserInputRequest;
test('questions remain between their prompt and subsequent final answer', () => {
  const blocks = [{ id:'prompt',at:10 },{ id:'tools',at:20 },{ id:'final',at:40 }];
  const result = interleaveUserInput(blocks, [question('question',30)], block => new Date(block.at).toISOString());
  assert.deepEqual(result.map(block => 'request' in block ? block.request.id : block.id), ['prompt','tools','question','final']);
});
test('pending questions without later messages stay at the end; receipts are sorted', () => {
  const result = interleaveUserInput([{at:10}], [question('late',30),question('early',20)], block => new Date(block.at).toISOString());
  assert.deepEqual(result.slice(1).map(block => 'request' in block ? block.request.id : null), ['early','late']);
  assert.deepEqual(interleaveUserInput([], [], () => ''), []);
});
