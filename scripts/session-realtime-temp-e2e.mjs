import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const [baseUrl, sessionPath, sessionId, profileId] = process.argv.slice(2);
if (!baseUrl || !sessionPath || !sessionId || !profileId) {
  throw new Error('Usage: node scripts/session-realtime-temp-e2e.mjs <baseUrl> <sessionPath> <sessionId> <profileId>');
}

const detailUrl = `${baseUrl}/api/codex/sessions/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(profileId)}&tail=120`;
const streamUrl = `${baseUrl}/api/codex/sessions/${encodeURIComponent(sessionId)}/events?profile=${encodeURIComponent(profileId)}`;

const warmResponse = await fetch(detailUrl);
assert.equal(warmResponse.status, 200);
await warmResponse.arrayBuffer();

const controller = new AbortController();
const streamResponse = await fetch(streamUrl, {
  headers: { Accept: 'text/event-stream' },
  signal: controller.signal,
});
assert.equal(streamResponse.status, 200);
assert.ok(streamResponse.body);

const reader = streamResponse.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

async function readEvent(expectedEvent) {
  while (true) {
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).replace(/\r\n/g, '\n');
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      const event = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (event === expectedEvent) return data ? JSON.parse(data) : null;
    }

    const { done, value } = await reader.read();
    if (done) throw new Error(`event stream ended before ${expectedEvent}`);
    buffer += decoder.decode(value, { stream: true });
  }
}

await readEvent('ready');
const marker = `live-e2e-${Date.now()}`;
const timestamp = new Date().toISOString();
const startedAt = performance.now();
await appendFile(sessionPath, [
  JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'task_started' } }),
  JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: marker } }),
  JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'agent_message', phase: 'commentary', message: `${marker}-answer` } }),
  '',
].join('\n'), 'utf-8');

await readEvent('session-changed');
const eventLatencyMs = performance.now() - startedAt;
const refreshStartedAt = performance.now();
const refreshedResponse = await fetch(detailUrl);
assert.equal(refreshedResponse.status, 200);
const refreshed = await refreshedResponse.json();
const refreshLatencyMs = performance.now() - refreshStartedAt;
assert.equal(
  refreshed.session.timeline.some((entry) => entry.text === `${marker}-answer`),
  true,
  'incremental detail response did not include the appended answer'
);

controller.abort();
console.log(JSON.stringify({
  eventLatencyMs: Number(eventLatencyMs.toFixed(1)),
  refreshLatencyMs: Number(refreshLatencyMs.toFixed(1)),
  totalLatencyMs: Number((eventLatencyMs + refreshLatencyMs).toFixed(1)),
  responseBytes: Number(refreshedResponse.headers.get('content-length') || 0),
}, null, 2));
