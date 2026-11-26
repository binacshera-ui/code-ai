/** Scoped client of the existing product-owner FRONTEND. Never opens its backend. */
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { resolveCodexSharedSocket } from './codexSharedSocket.mjs';
import { NATIVE_FRAME_BYTES, NATIVE_BUFFER_BYTES } from './codexNativeTransport.mjs';

export class CodexLiveInputNativeError extends Error {
  constructor({ code = 'NATIVE_UNAVAILABLE', rejected = false, admission = null } = {}) {
    super(rejected ? 'Native live input request was rejected' : 'Native live input transport is unavailable');
    this.name = 'CodexLiveInputNativeError'; this.code = code;
    this.nativeRejected = rejected; this.admission = admission;
  }
}

function supportedVersion(userAgent) {
  const match = typeof userAgent === 'string' && userAgent.match(/\/(\d+)\.(\d+)\.(\d+)(?:\s|[-+]|$)/);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 171));
}

export async function connectCodexLiveInput({ codexHome, expectedUid = process.getuid?.(), requestTimeoutMs = 15_000 }) {
  let endpoint;
  try { endpoint = await resolveCodexSharedSocket(codexHome, expectedUid, true); }
  catch { throw new CodexLiveInputNativeError(); }
  const ws = new WebSocket(`ws+unix://${endpoint.socketPath}:/`, {
    maxPayload: NATIVE_FRAME_BYTES, perMessageDeflate: false, handshakeTimeout: 5000,
  });
  const pending = new Map(); let closed = false;
  const fail = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new CodexLiveInputNativeError()); }
    pending.clear();
  };
  ws.on('error', fail); ws.on('close', fail);
  ws.on('message', (bytes, binary) => {
    if (binary || bytes.length > NATIVE_FRAME_BYTES) { ws.terminate(); return; }
    let frame; try { frame = JSON.parse(bytes.toString()); } catch { ws.terminate(); return; }
    // Do not answer or adopt server requests belonging to the original run.
    if (frame.method) return;
    const request = pending.get(frame.id); if (!request) return;
    pending.delete(frame.id); clearTimeout(request.timer);
    if (frame.error) request.reject(new CodexLiveInputNativeError({
      code: typeof frame.error.code === 'number' ? frame.error.code : 'NATIVE_REJECTED',
      rejected: true, admission: frame.error.data?.codeAiAdmission === 'notAccepted' ? 'notAccepted' : null,
    }));
    else request.resolve(frame.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (closed || ws.readyState !== WebSocket.OPEN || pending.size >= 16 || ws.bufferedAmount > NATIVE_BUFFER_BYTES) {
      reject(new CodexLiveInputNativeError()); return;
    }
    // This connection can inspect delivery and append only a CAS-guarded live
    // message; it cannot start/queue/cancel turns or change any thread settings.
    if (!['initialize', 'thread/read', 'thread/turns/list', 'thread/items/list', 'turn/steer'].includes(method)) {
      reject(new CodexLiveInputNativeError({ code: 'NATIVE_METHOD_NOT_ALLOWED' })); return;
    }
    if (method === 'turn/steer' && (typeof params?.threadId !== 'string' || !params.threadId
        || typeof params.expectedTurnId !== 'string' || !params.expectedTurnId
        || !Array.isArray(params.input) || !params.input.length)) {
      reject(new CodexLiveInputNativeError({ code: 'NATIVE_CAS_REQUIRED' })); return;
    }
    const id = 'code-ai-live-' + randomUUID(), bytes = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(bytes) > NATIVE_FRAME_BYTES) { reject(new CodexLiveInputNativeError({ code: 'NATIVE_FRAME_TOO_LARGE' })); return; }
    const timer = setTimeout(() => { pending.delete(id); reject(new CodexLiveInputNativeError({ code: 'NATIVE_ACK_TIMEOUT' })); }, requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(bytes, error => {
      if (!error) return;
      const request = pending.get(id); if (!request) return;
      clearTimeout(request.timer); pending.delete(id); reject(new CodexLiveInputNativeError());
    });
  });
  const close = () => { if (!closed) { closed = true; ws.terminate(); fail(); } };
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve); ws.once('error', () => reject(new CodexLiveInputNativeError()));
      ws.once('close', () => reject(new CodexLiveInputNativeError()));
    });
    const initialized = await rpc('initialize', {
      clientInfo: { name: 'code-ai', title: 'Code AI live input', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    if (!supportedVersion(initialized?.userAgent)
        || typeof initialized?.codexHome !== 'string'
        || await realpath(initialized.codexHome) !== endpoint.codexHome
        || initialized?.codeAiSharedOwner?.version !== 1
        || initialized?.codeAiSharedOwner?.turnSettings !== true
        || initialized?.codeAiSharedOwner?.historyReads !== 'canonical-v1') {
      throw new CodexLiveInputNativeError({ code: 'NATIVE_CAPABILITY_UNAVAILABLE' });
    }
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    return { rpc, close };
  } catch (error) { close(); throw error instanceof CodexLiveInputNativeError ? error : new CodexLiveInputNativeError(); }
}
