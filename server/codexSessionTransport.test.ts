import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodexSessionDetail, CodexTimelineEntry } from './codexService.js';
import { prepareSessionDetailForClient } from './codexSessionTransport.js';

function buildDetail(timeline: CodexTimelineEntry[]): CodexSessionDetail {
  return {
    id: 'session-1',
    title: 'Large session',
    updatedAt: '2026-08-30T00:00:00.000Z',
    createdAt: '2026-08-29T00:00:00.000Z',
    profileId: 'developer',
    cwd: '/workspace',
    messageCount: timeline.length,
    preview: 'preview',
    startPreview: 'start',
    endPreview: 'end',
    path: '/tmp/session.jsonl',
    source: 'cli',
    modelProvider: 'openai',
    messages: [{
      id: 'duplicated-message',
      role: 'assistant',
      kind: 'final',
      text: 'duplicated '.repeat(20_000),
      timestamp: '2026-08-30T00:00:00.000Z',
    }],
    timeline,
    totalTimelineEntries: 1_000 + timeline.length,
    timelineWindowStart: 1_000,
    timelineWindowEnd: 1_000 + timeline.length,
    hasEarlierTimeline: true,
  };
}

test('client session transport keeps a contiguous latest window under its byte budget', () => {
  const timeline = Array.from({ length: 40 }, (_, index): CodexTimelineEntry => ({
    id: `tool-${index}`,
    entryType: 'tool',
    timestamp: `2026-08-30T00:00:${String(index).padStart(2, '0')}.000Z`,
    toolName: 'exec',
    title: 'Tool',
    text: `output-${index}-`.repeat(2_000),
    toolOutputText: `output-${index}-`.repeat(2_000),
  }));
  const source = buildDetail(timeline);
  const prepared = prepareSessionDetailForClient(source, {
    maxTimelineBytes: 64 * 1024,
    maxToolFieldBytes: 24 * 1024,
  });

  assert.equal(prepared.messages.length, 0);
  assert.ok(prepared.timeline.length > 0);
  assert.ok(prepared.timeline.length < timeline.length);
  assert.equal(prepared.timeline.at(-1)?.id, timeline.at(-1)?.id);
  assert.deepEqual(
    prepared.timeline.map((entry) => entry.id),
    timeline.slice(-prepared.timeline.length).map((entry) => entry.id)
  );
  assert.equal(prepared.timelineWindowStart, source.timelineWindowEnd - prepared.timeline.length);
  assert.equal(prepared.timelineWindowEnd, source.timelineWindowEnd);
  assert.equal(prepared.totalTimelineEntries, source.totalTimelineEntries);
  assert.equal(prepared.hasEarlierTimeline, true);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.timeline), 'utf8') <= 64 * 1024);
  assert.equal(prepared.timeline.every((entry) => entry.text === undefined), true);
});

test('client session transport bounds one oversized tool entry without losing metadata', () => {
  const source = buildDetail([{
    id: 'oversized-tool',
    entryType: 'tool',
    timestamp: '2026-08-30T00:00:00.000Z',
    toolName: 'exec',
    title: 'Terminal',
    status: 'completed',
    toolInputText: 'i'.repeat(200_000),
    toolOutputText: 'o'.repeat(400_000),
    text: 'o'.repeat(400_000),
  }]);
  const prepared = prepareSessionDetailForClient(source, {
    maxTimelineBytes: 64 * 1024,
    maxToolFieldBytes: 16 * 1024,
  });
  const entry = prepared.timeline[0];

  assert.equal(entry.id, 'oversized-tool');
  assert.equal(entry.toolName, 'exec');
  assert.equal(entry.status, 'completed');
  assert.equal(entry.text, undefined);
  assert.ok(Buffer.byteLength(entry.toolInputText || '', 'utf8') <= 16 * 1024);
  assert.ok(Buffer.byteLength(entry.toolOutputText || '', 'utf8') <= 16 * 1024);
  assert.match(entry.toolOutputText || '', /shortened for fast display/);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.timeline), 'utf8') <= 64 * 1024);
});
