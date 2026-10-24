import net from 'node:net';
import { lstat, realpath, readFile, writeFile, chown, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const failure = code => Object.assign(new Error(code), { code });
const nullableStat = filename => lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const sameInode = (left, right) => left && right && left.ino === right.ino && left.dev === right.dev;
const privateFile = (value, uid) => value?.isFile() && !value.isSymbolicLink() && value.uid === uid && !(value.mode & 0o077);
async function parentIdentity(socketPath, uid) {
  const directory = path.dirname(socketPath), parent = await lstat(directory);
  if (!path.isAbsolute(socketPath) || socketPath.includes('\0') || !parent.isDirectory() || parent.isSymbolicLink()
      || parent.uid !== uid || (parent.mode & 0o077) || await realpath(directory) !== directory) throw failure('MODE_ENDPOINT_INVALID');
}
async function incarnation(pid) {
  const directory = `/proc/${pid}`;
  try {
    const info = await lstat(directory), value = await readFile(`${directory}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19])) throw failure('MODE_ENDPOINT_BUSY');
    return { processUid: info.uid, processStartTime: fields[19] };
  } catch (error) { if (error.code === 'ENOENT') return null; throw failure('MODE_ENDPOINT_BUSY'); }
}
async function bootId() {
  const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!/^[a-f0-9-]{36}$/.test(value)) throw failure('MODE_ENDPOINT_BUSY');
  return value;
}
async function listening(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let done = false;
    const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(500, () => { if (!done) { done = true; socket.destroy(); reject(failure('MODE_ENDPOINT_BUSY')); } });
    socket.once('connect', () => finish(true));
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish(false);
      else if (!done) { done = true; socket.destroy(); reject(failure('MODE_ENDPOINT_BUSY')); }
    });
  });
}

/** Recover only this bridge's private, disconnected endpoint after proven owner death. */
export async function recoverModeEndpoint(socketPath, uid) {
  await parentIdentity(socketPath, uid);
  const socket = await nullableStat(socketPath), custodyPath = `${socketPath}.custody.json`;
  const custody = await nullableStat(custodyPath);
  if (!socket && !custody) return false;
  if ((socket && (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid || (socket.mode & 0o077)))
      || !privateFile(custody, uid) || custody.size > 4096) throw failure('MODE_ENDPOINT_BUSY');
  let marker;
  try { marker = JSON.parse(await readFile(custodyPath, 'utf8')); } catch { throw failure('MODE_ENDPOINT_BUSY'); }
  if (marker?.format !== 'code-ai-mode-endpoint-custody' || marker.version !== 1 || marker.socketPath !== socketPath || marker.uid !== uid
      || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || !Number.isSafeInteger(marker.processUid) || marker.processUid < 0
      || !/^\d+$/.test(marker.processStartTime) || !/^[a-f0-9-]{36}$/.test(marker.bootId)
      || !Number.isSafeInteger(marker.ino) || !Number.isSafeInteger(marker.dev)
      || (socket && (socket.ino !== marker.ino || socket.dev !== marker.dev))) throw failure('MODE_ENDPOINT_BUSY');
  const currentBoot = await bootId();
  const owner = currentBoot === marker.bootId ? await incarnation(marker.pid) : null;
  if (owner && owner.processUid === marker.processUid && owner.processStartTime === marker.processStartTime) throw failure('MODE_ENDPOINT_BUSY');
  if (socket && await listening(socketPath)) throw failure('MODE_ENDPOINT_BUSY');
  const currentSocket = await nullableStat(socketPath), currentCustody = await nullableStat(custodyPath);
  if ((socket ? !sameInode(socket, currentSocket) : currentSocket) || !sameInode(custody, currentCustody)) throw failure('MODE_ENDPOINT_BUSY');
  if (socket) await unlink(socketPath);
  await unlink(custodyPath);
  return true;
}

export async function recordModeEndpointCustody(socketPath, uid, gid) {
  const socket = await lstat(socketPath);
  const own = await incarnation(process.pid);
  if (!own || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077)) throw failure('MODE_ENDPOINT_INVALID');
  const custodyPath = `${socketPath}.custody.json`, temporary = `${custodyPath}.${process.pid}.${randomUUID()}.tmp`;
  const marker = { format: 'code-ai-mode-endpoint-custody', version: 1, socketPath, uid,
    ino: socket.ino, dev: socket.dev, pid: process.pid, ...own, bootId: await bootId() };
  if (await nullableStat(custodyPath)) throw failure('MODE_ENDPOINT_BUSY');
  try {
    await writeFile(temporary, JSON.stringify(marker) + '\n', { mode: 0o600, flag: 'wx' });
    await chown(temporary, uid, gid); await rename(temporary, custodyPath);
  } finally { await unlink(temporary).catch(() => undefined); }
  const installed = await lstat(custodyPath);
  return { async remove() {
    const current = await nullableStat(custodyPath);
    if (privateFile(current, uid) && sameInode(current, installed)) await unlink(custodyPath);
  } };
}
