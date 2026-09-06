import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeCodexSessionRow } from './codexSessionMessages.js';

test('only public completed message events are normalized; raw context and reasoning stay excluded', () => {
  const row = { type: 'event_msg', timestamp: '2026-09-06T06:00:00Z', payload: { type: 'item_completed', item: {
    type: 'UserMessage', content: [{ type: 'text', text: 'one' }, { type: 'image', url: 'private' }, { type: 'text', text: 'two' }],
  } } };
  assert.equal(normalizeCodexSessionRow(row).payload.message, 'one\ntwo');
  for (const ignored of [
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning', raw_content: [] } } },
  ]) assert.equal(normalizeCodexSessionRow(ignored), ignored);
});

test('new and legacy rollouts render user, commentary and final bubbles once in full and incremental loads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-message-events-'));
  const codexHome = path.join(root, 'home');
  const dir = path.join(codexHome, 'sessions', '2026', '09', '06');
  await fs.mkdir(dir, { recursive: true });
  process.env.CODEX_APP_ROOT = root;
  process.env.CODEX_STORAGE_ROOT = path.join(root, 'state');
  process.env.CODEX_PROFILES_JSON = JSON.stringify([{ id: 'fixture', label: 'Fixture', provider: 'codex', codexHome, workspaceCwd: root }]);
  const sessionId = '11111111-2222-4333-8444-999999999999';
  const file = path.join(dir, `rollout-${sessionId}.jsonl`);
  const event = (payload: any, seconds: number) => ({ type: 'event_msg', timestamp: `2026-09-06T06:00:${String(seconds).padStart(2, '0')}.000Z`, payload });
  const completed = (type: string, text: string, phase: string | undefined, seconds: number) => event({ type: 'item_completed', item: { type, id: `item-${seconds}`, content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text }], phase } }, seconds);
  const rows = [
    { type: 'session_meta', timestamp: '2026-09-06T06:00:00.000Z', payload: { id: sessionId, cwd: root, source: 'cli' } },
    event({ type: 'task_started' }, 1),
    event({ type: 'user_message', message: 'Legacy user' }, 2),
    event({ type: 'agent_message', message: 'Legacy final', phase: 'final' }, 3),
    event({ type: 'task_complete', last_agent_message: 'Legacy final' }, 4),
    event({ type: 'task_started' }, 5),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Injected context' }] } },
    completed('UserMessage', 'New user', undefined, 6),
    completed('AgentMessage', 'Progress', 'commentary', 7),
    { type: 'response_item', timestamp: '2026-09-06T06:00:08.000Z', payload: { type: 'function_call', name: 'check', call_id: 'call-1', arguments: '{}' } },
    completed('AgentMessage', 'New final', 'final_answer', 9),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'New final' }] } },
    event({ type: 'task_complete', last_agent_message: 'New final' }, 10),
  ];
  await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const service = await import('./codexService.js');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const first = await service.getCodexSessionDetail(sessionId, 'fixture', { tail: 120 });
  assert.deepEqual(first.timeline.filter(e => e.entryType === 'message').map(e => [e.role, e.kind, e.text]), [
    ['user', 'prompt', 'Legacy user'], ['assistant', 'final', 'Legacy final'],
    ['user', 'prompt', 'New user'], ['assistant', 'commentary', 'Progress'], ['assistant', 'final', 'New final'],
  ]);
  assert.equal(first.timeline.filter(e => e.entryType === 'tool').length, 1);
  assert.equal(first.lastCompletedAt, '2026-09-06T06:00:10.000Z');
  await fs.appendFile(file, [event({ type: 'task_started' }, 11), completed('UserMessage', 'Follow-up', undefined, 12), completed('AgentMessage', 'Follow-up progress', 'commentary', 13)].map(row => JSON.stringify(row)).join('\n') + '\n');
  const incremental = await service.getCodexSessionDetail(sessionId, 'fixture', { tail: 120 });
  const full = await service.getCodexSessionDetail(sessionId, 'fixture', { full: true });
  assert.deepEqual(incremental.timeline, full.timeline);
  assert.equal(full.messageCount, 7);
  const summaries = await service.listCodexSessions('fixture');
  assert.equal(summaries[0]?.endPreview, 'Follow-up progress');
});
