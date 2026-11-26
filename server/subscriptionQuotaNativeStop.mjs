/** Quota emergency stop for the existing canonical owner, not another executor.
 * Native Codex keeps turn/history custody. Interrupt ACKs are never terminal proof.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { resolveCodexSharedSocket } from './codexSharedSocket.mjs';
import { isCodexApiModel } from '../shared/codexApiModels.mjs';
import { NATIVE_FRAME_BYTES } from './codexNativeTransport.mjs';

const terminal = new Set(['completed', 'interrupted', 'failed']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const metadataReaders = new Map();
const MAX_METADATA_LINE = 256 * 1024;

/** The Thread.model field is future configuration, NOT the active turn model.
 * Read only exact turn_context metadata from the native rollout. Large prompt,
 * image and tool-result lines are skipped without parsing or retaining them.
 * Append-aware caching still observes model changes within the same turn.
 */
export async function readNativeQuotaTurnModel(filename, turnId) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !filename.endsWith('.jsonl') || !id(turnId)) return null;
  try {
    const info = await stat(filename);
    if (!info.isFile()) return null;
    let reader = metadataReaders.get(filename);
    if (!reader || reader.ino !== info.ino || reader.dev !== info.dev || reader.offset > info.size
        || reader.offset === info.size && reader.mtime !== info.mtimeMs) {
      reader = { ino: info.ino, dev: info.dev, offset: 0, mtime: info.mtimeMs,
        tail: Buffer.alloc(0), skipping: false, models: new Map() };
      metadataReaders.set(filename, reader);
    }
    if (reader.pending) { await reader.pending; return reader.models.get(turnId) ?? null; }
    const read = async () => {
      if (reader.offset >= info.size) return;
      const stream = createReadStream(filename, { start: reader.offset, end: info.size - 1, highWaterMark: 64 * 1024 });
      for await (const chunk of stream) {
        reader.offset += chunk.length;
        let start = 0;
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
          const length = reader.tail.length + end - start;
          if (!reader.skipping && length <= MAX_METADATA_LINE) {
            const line = reader.tail.length ? Buffer.concat([reader.tail, chunk.subarray(start, end)]) : chunk.subarray(start, end);
            // Only metadata matches reach JSON.parse; no prompt text is returned.
            if (line.includes(Buffer.from('turn_context'))) {
              let value; try { value = JSON.parse(line.toString('utf8')); } catch {}
              if (value?.type === 'turn_context' && id(value.payload?.turn_id)
                  && typeof value.payload.model === 'string' && value.payload.model.length <= 200) {
                reader.models.delete(value.payload.turn_id);
                reader.models.set(value.payload.turn_id, value.payload.model);
                if (reader.models.size > 1024) reader.models.delete(reader.models.keys().next().value);
              }
            }
          }
          reader.tail = Buffer.alloc(0); reader.skipping = false;
          start = end + 1;
        }
        if (start < chunk.length && !reader.skipping) {
          if (reader.tail.length + chunk.length - start > MAX_METADATA_LINE) {
            reader.tail = Buffer.alloc(0); reader.skipping = true;
          } else reader.tail = Buffer.concat([reader.tail, chunk.subarray(start)]);
        }
      }
      reader.mtime = info.mtimeMs;
    };
    reader.pending = read();
    try { await reader.pending; } finally { reader.pending = null; }
    // Bound process-local metadata only; never alter the original transcript.
    if (metadataReaders.size > 64) metadataReaders.delete(metadataReaders.keys().next().value);
    return reader.models.get(turnId) ?? null;
  } catch { return null; }
}

/** The same private socket validation already used by Code AI account actions. */
export async function connectNativeQuotaOwner(profile, { rpcTimeoutMs = 5000 } = {}) {
  const endpoint = await resolveCodexSharedSocket(profile.codexHome, process.getuid(), true);
  const ws = new WebSocket(`ws+unix://${endpoint.socketPath}:/`, {
    handshakeTimeout: rpcTimeoutMs, perMessageDeflate: false, maxPayload: NATIVE_FRAME_BYTES,
  });
  const pending = new Map();
  let next = 0;
  const closed = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Quota owner connection unavailable')); }
    pending.clear();
  };
  ws.on('error', closed); ws.on('close', closed);
  ws.on('message', bytes => {
    let frame; try { frame = JSON.parse(bytes.toString()); } catch { return; }
    const p = pending.get(frame.id); if (!p) return;
    pending.delete(frame.id); clearTimeout(p.timer);
    frame.error ? p.reject(new Error('Quota owner request refused')) : p.resolve(frame.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error('Quota owner connection unavailable')); return; }
    const requestId = ++next;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Quota owner acknowledgement unavailable')); }, rpcTimeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: requestId, method, params }), error => {
      if (error) { const p = pending.get(requestId); pending.delete(requestId); clearTimeout(timer); p?.reject(new Error('Quota owner write unavailable')); }
    });
  });
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('Quota owner connection unavailable'))); });
    const result = await rpc('initialize', { clientInfo: { name: 'code-ai-quota-stop', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    if (result?.codexHome !== endpoint.codexHome) throw new Error('Quota owner profile mismatch');
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    return { rpc, close() { ws.terminate(); closed(); } };
  } catch { ws.terminate(); closed(); throw new Error('Quota owner connection unavailable'); }
}

async function pages(rpc, method, params, limit = 100) {
  const rows = [], cursors = new Set();
  let cursor;
  for (let page = 0; page < 1000; page++) {
    const result = await rpc(method, { ...params, limit, ...(cursor ? { cursor } : {}) });
    if (!object(result) || !Array.isArray(result.data)) throw new Error('Native quota metadata unavailable');
    rows.push(...(method === 'thread/queue/list' ? result.data.map(row => ({ id: row?.id })) : result.data));
    if (!result.nextCursor) return rows;
    if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new Error('Native quota pagination unavailable');
    cursor = result.nextCursor; cursors.add(cursor);
  }
  throw new Error('Native quota metadata exceeds page budget');
}

async function activeTurns(rpc, threadId) {
  const result = await rpc('thread/turns/list', { threadId, limit: 20, itemsView: 'notLoaded', sortDirection: 'desc' });
  if (!object(result) || !Array.isArray(result.data)) throw new Error('Native turn metadata unavailable');
  return result.data;
}

/** Call repeatedly while blocked. Does not subscribe, resume, start, replay,
 * clear goals, signal processes or delete history. Unknown billing stays pending.
 * isBlocked is rechecked before mutations to respect a concurrent user release.
 */
export async function stopNativeSubscriptionTurns(profile, {
  isBlocked,
  connect = connectNativeQuotaOwner,
  readTurnModel = readNativeQuotaTurnModel,
  confirmationMs = 1500,
  pollMs = 100,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (typeof isBlocked !== 'function') throw new Error('Current subscription stop state is required');
  const report = { ownerConnected: false, threadsSeen: 0, apiTurnsSkipped: [], attemptedTurns: [],
    confirmedTurns: [], pendingTurns: [], deletedQueuedInputs: [], pendingQueuedInputs: [], errors: [] };
  if (profile?.provider !== 'codex' || !await isBlocked(profile)) return report;
  let channel;
  const error = (stage, threadId) => report.errors.push({ stage, ...(threadId ? { threadId } : {}), code: 'NATIVE_QUOTA_STOP_UNAVAILABLE' });
  try {
    channel = await connect(profile); report.ownerConnected = true;
    const threads = await pages(channel.rpc, 'thread/loaded/list', {});
    for (const threadId of new Set(threads)) {
      if (!id(threadId)) { error('thread-identity'); continue; }
      report.threadsSeen++;
      try {
        const snapshot = await channel.rpc('thread/read', { threadId, includeTurns: false });
        const thread = snapshot?.thread;
        if (!object(thread) || thread.id !== threadId) throw new Error('Native thread identity unavailable');
        // Queued inputs have no per-turn model yet. Native dispatch consumes
        // the configured model, while active turns require exact turn_context.
        const queued = await pages(channel.rpc, 'thread/queue/list', { threadId });
        for (const row of queued) {
          if (!id(row?.id)) { error('queued-identity', threadId); continue; }
          const target = { threadId, queuedSubmissionId: row.id };
          if (isCodexApiModel(thread.model)) continue;
          if (typeof thread.model !== 'string' || !thread.model) { report.pendingQueuedInputs.push(target); continue; }
          if (!await isBlocked(profile)) return report;
          try {
            const deleted = await channel.rpc('thread/queue/delete', target);
            if (deleted?.deleted === true) report.deletedQueuedInputs.push(target);
            else report.pendingQueuedInputs.push(target); // Dispatch may have won the race.
          } catch { report.pendingQueuedInputs.push(target); error('queued-delete', threadId); }
        }
        if (thread.status?.type !== 'active') continue;
        const turns = (await activeTurns(channel.rpc, threadId)).filter(turn => turn?.status === 'inProgress' && id(turn.id));
        if (!turns.length) { error('active-turn-identity', threadId); continue; }
        for (const turn of turns) {
          const target = { threadId, turnId: turn.id };
          const model = await readTurnModel(thread.path, turn.id);
          if (isCodexApiModel(model)) { report.apiTurnsSkipped.push(target); continue; }
          if (typeof model !== 'string' || !model) { report.pendingTurns.push({ ...target, reason: 'billing-model-unavailable' }); continue; }
          if (!await isBlocked(profile)) return report;
          report.attemptedTurns.push(target);
          try { await channel.rpc('turn/interrupt', target); }
          catch { error('turn-interrupt', threadId); }
          // A concurrent completion can beat the interrupt. Keep its true native
          // status rather than misreporting it as cancelled by this control.
          const deadline = now() + Math.max(0, confirmationMs);
          let settled = null;
          do {
            try {
              const current = (await activeTurns(channel.rpc, threadId)).find(row => row?.id === turn.id);
              if (current && terminal.has(current.status)) { settled = current.status; break; }
            } catch { error('turn-confirmation', threadId); break; }
            if (now() >= deadline) break;
            await sleep(Math.min(Math.max(1, pollMs), Math.max(1, deadline - now())));
          } while (now() <= deadline);
          if (settled) report.confirmedTurns.push({ ...target, status: settled });
          else report.pendingTurns.push({ ...target, reason: 'terminal-status-unconfirmed' });
        }
      } catch { error('thread-inspection', threadId); }
    }
  } catch { error('owner-inspection'); }
  finally { channel?.close(); }
  return report;
}
