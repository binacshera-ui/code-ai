import net from 'node:net';
import { lstat, realpath, chmod, chown, unlink } from 'node:fs/promises';
import path from 'node:path';
import { recoverModeEndpoint, recordModeEndpointCustody } from './endpoint.mjs';

export const modeServers = Object.freeze(['personal_chrome', 'browser_mode', 'phone_mode', 'design_mode', 'ux_mode']);
const maxBytes = 8 * 1024 * 1024;
const timeoutMs = 360000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function modeError(code) { return Object.assign(new Error(code), { code }); }
export function modeFailure(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'MODE_TOOL_FAILED';
  return { isError: true, content: [{ type: 'text', text: code }], structuredContent: { error_code: code } };
}
export function nativeModeCall(server, params) {
  if (!modeServers.includes(server) || !object(params) || typeof params.name !== 'string'
      || !/^[A-Za-z0-9_]{1,160}$/.test(params.name) || !object(params._meta)
      || typeof params._meta.threadId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(params._meta.threadId)
      || (params.arguments !== undefined && !object(params.arguments))) throw modeError('MODE_UNBOUND');
  return { server, nativeThreadId: params._meta.threadId, toolName: params.name,
    arguments: params.arguments || {},
    ...(typeof params._meta.itemId === 'string' && params._meta.itemId.length <= 160 ? { nativeItemId: params._meta.itemId } : {}) };
}
export async function validateModeEndpoint(socketPath, uid = process.getuid()) {
  if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) throw modeError('MODE_ENDPOINT_INVALID');
  const parent = await lstat(path.dirname(socketPath));
  const socket = await lstat(socketPath);
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077)
      || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid || (socket.mode & 0o077)
      || await realpath(path.dirname(socketPath)) !== path.dirname(socketPath)) throw modeError('MODE_ENDPOINT_INVALID');
}
export async function callSharedMode(socketPath, server, params) {
  const call = nativeModeCall(server, params);
  await validateModeEndpoint(socketPath).catch(() => { throw modeError('MODE_UNAVAILABLE'); });
  const frame = JSON.stringify(call) + '\n';
  if (Buffer.byteLength(frame) > maxBytes) throw modeError('MODE_PAYLOAD_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let buffer = '', done = false;
    const finish = (error, value) => {
      if (done) return; done = true; socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(modeError('MODE_TIMEOUT')));
    socket.on('error', () => finish(modeError('MODE_UNAVAILABLE')));
    socket.on('end', () => { if (!done) finish(modeError('MODE_UNAVAILABLE')); });
    socket.on('connect', () => socket.write(frame));
    socket.on('data', bytes => {
      buffer += bytes.toString();
      if (Buffer.byteLength(buffer) > maxBytes) { finish(modeError('MODE_PAYLOAD_TOO_LARGE')); return; }
      const end = buffer.indexOf('\n'); if (end < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, end));
        if (!object(result) || !Array.isArray(result.content)) throw new Error();
        finish(null, result);
      } catch { finish(modeError('MODE_INVALID_RESPONSE')); }
    });
  });
}
export async function createSharedModeBridge({ socketPath, uid, gid, resolve }) {
  const directory = path.dirname(socketPath), parent = await lstat(directory);
  if (!path.isAbsolute(socketPath) || !parent.isDirectory() || parent.isSymbolicLink()
      || parent.uid !== uid || (parent.mode & 0o077) || await realpath(directory) !== directory) throw modeError('MODE_ENDPOINT_INVALID');
  await recoverModeEndpoint(socketPath, uid);
  const clients = new Map(); let closing = false;
  const server = net.createServer(socket => {
    clients.set(socket, false); socket.once('close', () => clients.delete(socket));
    socket.setTimeout(timeoutMs, () => socket.destroy());
    socket.on('error', () => undefined);
    let buffer = '', accepted = false;
    socket.on('data', bytes => {
      if (accepted || closing) { socket.destroy(); return; }
      buffer += bytes.toString();
      if (Buffer.byteLength(buffer) > maxBytes) { socket.destroy(); return; }
      const end = buffer.indexOf('\n'); if (end < 0) return;
      accepted = true;
      clients.set(socket, true);
      void (async () => {
        let result;
        try {
          const frame = JSON.parse(buffer.slice(0, end)); buffer = '';
          if (!object(frame)) throw modeError('MODE_UNBOUND');
          const call = nativeModeCall(frame.server, { name: frame.toolName, arguments: frame.arguments,
            _meta: { threadId: frame.nativeThreadId, itemId: frame.nativeItemId } });
          result = await resolve(call);
          if (!object(result) || !Array.isArray(result.content)) throw modeError('MODE_INVALID_RESPONSE');
        } catch (error) { result = modeFailure(error); }
        const output = JSON.stringify(result) + '\n';
        socket.end(Buffer.byteLength(output) <= maxBytes ? output : JSON.stringify(modeFailure(modeError('MODE_PAYLOAD_TOO_LARGE'))) + '\n');
      })();
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(socketPath, done); });
  let installed, custody;
  try {
    await chmod(socketPath, 0o600); await chown(socketPath, uid, gid);
    installed = await lstat(socketPath);
    custody = await recordModeEndpointCustody(socketPath, uid, gid);
  } catch (error) {
    for (const socket of clients.keys()) socket.destroy();
    await new Promise(done => server.close(done));
    if (custody) await custody.remove();
    throw error;
  }
  let closePromise;
  return { socketPath, close: () => closePromise ||= (async () => {
    closing = true;
    for (const [socket, accepted] of clients) if (!accepted) socket.destroy();
    // Allow accepted mode operations to finish; never cancel a native turn.
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    const current = await lstat(socketPath).catch(() => null);
    if (current?.isSocket() && current.ino === installed.ino && current.dev === installed.dev) await unlink(socketPath);
    await custody.remove();
  })() };
}
