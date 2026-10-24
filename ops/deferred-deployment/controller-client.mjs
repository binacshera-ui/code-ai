import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_BYTES = 32_768;

function failure(reason) {
  const error = new Error('Private deployment controller request failed.');
  error.reason = reason;
  return error;
}

function checkOwnedPrivate(stat, reason) {
  if ((stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw failure(reason);
  }
}

export function readControllerPointer(controllerFile) {
  if (!path.isAbsolute(controllerFile)) throw failure('invalid_controller_path');
  const stat = fs.lstatSync(controllerFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw failure('controller_pointer_invalid');
  checkOwnedPrivate(stat, 'controller_pointer_not_private');
  let pointer;
  try { pointer = JSON.parse(fs.readFileSync(controllerFile, 'utf8')); }
  catch { throw failure('controller_pointer_invalid'); }
  if (pointer?.format !== 'code-ai-deployment-drain-controller' || pointer.version !== 1
    || !UUID.test(pointer.runtimeEpoch) || !Number.isSafeInteger(pointer.runtimePid) || pointer.runtimePid <= 0
    || typeof pointer.socketPath !== 'string') throw failure('controller_pointer_invalid');
  const privateRoot = path.join(path.dirname(controllerFile), 'private');
  if (path.dirname(pointer.socketPath) !== privateRoot) throw failure('controller_socket_outside_private_root');
  const directory = fs.lstatSync(privateRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure('controller_directory_invalid');
  checkOwnedPrivate(directory, 'controller_directory_not_private');
  const socket = fs.lstatSync(pointer.socketPath);
  if (!socket.isSocket() || socket.isSymbolicLink()) throw failure('controller_socket_invalid');
  checkOwnedPrivate(socket, 'controller_socket_not_private');
  return pointer;
}

export async function requestController(controllerFile, request, { timeoutMs = 2_000, signal } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw failure('invalid_controller_timeout');
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || !['status', 'acquire', 'renew', 'seal', 'release'].includes(request.action)) throw failure('invalid_control_request');
  const encoded = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(encoded) > 8_192) throw failure('invalid_control_request');
  const pointer = readControllerPointer(controllerFile);
  if (request.action !== 'status' && request.runtimeEpoch !== pointer.runtimeEpoch) throw failure('runtime_epoch_mismatch');
  if (signal?.aborted) throw failure('cycle_deadline');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pointer.socketPath);
    let received = '';
    let settled = false;
    const abort = () => socket.destroy(failure('cycle_deadline'));
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => socket.destroy(failure('controller_timeout')));
    socket.once('error', (error) => finish(failure(error.reason || 'controller_unavailable')));
    socket.once('connect', () => socket.end(encoded));
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (Buffer.byteLength(received) > MAX_BYTES) socket.destroy(failure('controller_response_too_large'));
    });
    socket.once('end', () => {
      try {
        const reply = JSON.parse(received);
        if (reply?.ok !== true) throw failure(/^[a-z_]{1,80}$/.test(reply?.reason || '') ? reply.reason : 'controller_refused');
        if (!reply.result || reply.result.runtimeEpoch !== pointer.runtimeEpoch
          || reply.result.format !== 'code-ai-deployment-drain-status') throw failure('controller_response_invalid');
        finish(null, reply.result);
      } catch (error) { finish(failure(error.reason || 'controller_response_invalid')); }
    });
    socket.once('close', () => { if (!settled) finish(failure('controller_connection_closed')); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw failure('controller_path_required');
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk.toString('utf8');
      if (Buffer.byteLength(raw) > 8_192) throw failure('invalid_control_request');
    }
    console.log(JSON.stringify({ ok: true, result: await requestController(process.argv[2], JSON.parse(raw)) }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, reason: /^[a-z_]{1,80}$/.test(error.reason || '') ? error.reason : 'controller_request_failed' }));
    process.exitCode = 1;
  }
}
