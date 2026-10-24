/**
 * JSONL adapter for one already-running, same-user Codex Unix-socket owner.
 * Closing this adapter NEVER shuts down the owner or unlocks a thread.
 * Not an installer: native desktop/IDE clients must use the same owner too.
 */
import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { NATIVE_FRAME_BYTES, NATIVE_BUFFER_BYTES, NATIVE_HISTORY_READS } from '../server/codexNativeTransport.mjs';
import { readManagedNativeHistory } from '../server/codexQueuedRecovery.mjs';

const maxBytes = NATIVE_FRAME_BYTES;
let ws;
let stopped = false;
let buffer = '';
let initialized = false;
let initializeId;
let queuedBytes = 0;
const queued = [];

function stop(code) {
  if (stopped) return;
  stopped = true;
  buffer = '';
  queued.length = 0;
  process.stdin.pause();
  process.stdin.destroy();
  ws?.terminate();
  // Fixed diagnostics only; protocol/config/credential content is never logged.
  if (code) process.stderr.write('CODE_AI_SHARED_TRANSPORT_UNAVAILABLE\n');
  process.exitCode = code;
}

async function main() {
  const socketPath = process.argv[2];
  const home = process.env.CODEX_HOME;
  if (process.platform === 'win32' || !socketPath || !path.isAbsolute(socketPath)
      || socketPath.includes(':') || !home || !path.isAbsolute(home)) throw new Error('Unsupported endpoint');
  const expectedHome = await realpath(home);
  const socket = await lstat(socketPath);
  const parent = await lstat(path.dirname(socketPath));
  const uid = process.getuid();
  // Validate a private same-user boundary, not merely a loopback-looking path.
  // Codex's canonical socket may be a symlink into its private /tmp directory.
  const actualSocket = await lstat(await realpath(socketPath));
  const actualParent = await lstat(path.dirname(await realpath(socketPath)));
  if ((!socket.isSocket() && !socket.isSymbolicLink()) || !actualSocket.isSocket()
      || socket.uid !== uid || actualSocket.uid !== uid
      || parent.uid !== uid || actualParent.uid !== uid
      || (parent.mode & 0o077) !== 0 || (actualParent.mode & 0o077) !== 0) throw new Error('Endpoint ownership mismatch');

  ws = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: maxBytes, handshakeTimeout: 10_000, perMessageDeflate: false });
  ws.on('error', () => stop(1));
  ws.on('close', () => stop(stopped ? process.exitCode || 0 : 1));
  ws.on('open', () => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('error', () => stop(1));
    process.stdin.on('end', () => stop(0));
    process.stdin.on('data', chunk => {
      if (stopped) return;
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0 && !stopped) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > maxBytes) { stop(1); break; }
        let frame;
        try { frame = JSON.parse(line); } catch { stop(1); break; }
        if (frame?.method === 'initialize') initializeId = frame.id;
        else if (!initialized) {
          queuedBytes += Buffer.byteLength(line);
          if (queuedBytes > NATIVE_BUFFER_BYTES) { stop(1); break; }
          queued.push(line);
          continue;
        }
        // Managed history reads use proved private native custody, avoiding an
        // older broker's 8MB cap without restarting its active native jobs.
        // Every mutation and question answer still enters the same broker.
        if (initialized && managedOwner && NATIVE_HISTORY_READS.has(frame.method) && Object.hasOwn(frame, 'id')) {
          const id = frame.id, inputBytes = Buffer.byteLength(line);
          historyBytes += inputBytes;
          if (++historyPending > 8 || historyBytes > NATIVE_BUFFER_BYTES) { stop(1); break; }
          void readManagedNativeHistory({codexHome:expectedHome,method:frame.method,params:frame.params})
            .then(result => writeOutput({id,result}), () => writeOutput({id,error:{code:-32603,message:'Native history custody unavailable'}}))
            .finally(() => { historyPending--; historyBytes -= inputBytes; });
        } else ws.send(line, error => { if (error) stop(1); });
      }
      if (Buffer.byteLength(buffer) > maxBytes) stop(1);
    });
    process.stdin.resume();
  });
  let delivery = Promise.resolve();
  let deliveryBytes = 0;
  let managedOwner = false, historyPending = 0, historyBytes = 0;
  function writeOutput(frame) {
    if (stopped) return;
    const line = JSON.stringify(frame) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > maxBytes || process.stdout.writableLength + bytes > NATIVE_BUFFER_BYTES) { stop(1); return; }
    if (!process.stdout.write(line)) {
      ws.pause();
      process.stdout.once('drain', () => { if (!stopped) ws.resume(); });
    }
  }
  async function deliver(data, binary) {
    if (stopped || binary || data.length > maxBytes) { stop(1); return; }
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { stop(1); return; }
    if (!initialized) {
      // Some native versions emit connection notifications alongside initialize.
      // Never expose them until profile identity has been checked. Processing
      // messages sequentially also prevents async realpath validation racing
      // with the next websocket frame.
      if (typeof frame.method === 'string') return;
      if (frame.id !== initializeId || !frame.result || typeof frame.result.codexHome !== 'string') { stop(1); return; }
      const actualHome = await realpath(frame.result.codexHome).catch(() => null);
      if (stopped) return;
      if (actualHome !== expectedHome) { stop(1); return; }
      initialized = true;
      const custodyFile = path.join(path.dirname(expectedHome), 'code-ai-native-owner', 'ownership.json');
      const custodyPresent = await lstat(custodyFile).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
      managedOwner = frame.result.codeAiSharedOwner?.version === 1 && custodyPresent;
    }
    writeOutput(frame);
    if (queued.length) {
      for (const line of queued.splice(0)) ws.send(line, error => { if (error) stop(1); });
      queuedBytes = 0;
    }
  }
  ws.on('message', (data, binary) => {
    deliveryBytes += data.length;
    if (deliveryBytes > NATIVE_BUFFER_BYTES) { stop(1); return; }
    delivery = delivery.then(() => deliver(data, binary)).catch(() => stop(1))
      .finally(() => { deliveryBytes -= data.length; });
  });
  process.stdout.on('error', () => stop(1));
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));
main().catch(() => stop(1));
