/** Read-only native connection/settings census. No transcripts or config emitted. */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { resolveCodexSharedSocket } from '../../server/codexSharedSocket.mjs';

const [home, uidText, endpointKind] = process.argv.slice(2);
if (!/^[0-9]+$/.test(uidText || '')) throw new Error('Explicit endpoint UID required');
const endpoint = await resolveCodexSharedSocket(home, Number(uidText), endpointKind === 'product');
const ws = new WebSocket(`ws+unix://${endpoint.socketPath}:/`, { perMessageDeflate: false,
  maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5000 });
let next = 0;
const pending = new Map();
function closePending() { for (const r of pending.values()) { clearTimeout(r.timer); r.reject(new Error('Native census unavailable')); } pending.clear(); }
ws.on('error', closePending); ws.on('close', closePending);
ws.on('message', (bytes, binary) => {
  if (binary) return ws.terminate();
  let m; try { m = JSON.parse(bytes.toString()); } catch { return ws.terminate(); }
  const r = pending.get(m.id); if (!r) return;
  pending.delete(m.id); clearTimeout(r.timer);
  if (m.error) r.reject(new Error('Native census request rejected'));
  else r.resolve(m.result);
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native census timed out')); }, 5000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
try {
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('Native census unavailable'))); });
  const init = await rpc('initialize', { clientInfo: { name: 'code-ai-owner-readonly-census', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  if (await realpath(init.codexHome) !== endpoint.codexHome) throw new Error('Native owner home mismatch');
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  const loaded = await rpc('thread/loaded/list', {});
  if (!Array.isArray(loaded.data)) throw new Error('Native census contract mismatch');
  const statusCounts = {};
  for (const threadId of loaded.data) {
    const r = await rpc('thread/read', { threadId, includeTurns: false });
    const type = r.thread?.status?.type;
    const status = ['idle', 'active', 'notLoaded', 'systemError'].includes(type) ? type : 'unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  console.log(JSON.stringify({ format: 'code-ai-native-owner-readonly-census', observedAt: new Date().toISOString(),
    home: endpoint.codexHome, uid: endpoint.uid, homeMatched: true, nativeUserAgent: init.userAgent,
    managedOwner: init.codeAiSharedOwner?.version === 1 && init.codeAiSharedOwner.turnSettings === true,
    loadedThreadCount: loaded.data.length, statusCounts, transcriptsPrinted: false, credentialValuesPrinted: false }));
} finally { ws.terminate(); }
