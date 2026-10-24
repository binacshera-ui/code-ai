import { lstat, readFile, writeFile, chown, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { modeError, modeServers, nativeModeCall } from './transport.mjs';

const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\x00-\x1f\x7f]/.test(value);
const validateThread = threadId => nativeModeCall('design_mode', { name: 'probe', _meta: { threadId } });
function validateBindings(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw modeError('MODE_CONTEXT_INVALID');
  const copy = {};
  for (const [server, binding] of Object.entries(bindings)) {
    if (!modeServers.includes(server)) throw modeError('MODE_CONTEXT_INVALID');
    if (binding === null) { copy[server] = null; continue; }
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
        || Object.keys(binding).sort().join(',') !== 'profileId,sessionKey'
        || !identifier(binding.profileId) || !identifier(binding.sessionKey)) throw modeError('MODE_CONTEXT_INVALID');
    copy[server] = { profileId: binding.profileId, sessionKey: binding.sessionKey };
  }
  return copy;
}

/** Non-secret custody metadata. Never records tokens, URLs, arguments or results. */
export async function createModeContexts(directory, uid, gid) {
  const filename = path.join(directory, 'mode-contexts.json');
  const current = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (current && (!current.isFile() || current.isSymbolicLink() || current.uid !== uid || (current.mode & 0o077)
      || current.size > 2 * 1024 * 1024)) throw modeError('MODE_CONTEXT_INVALID');
  const contexts = new Map();
  if (current) {
    let payload;
    try { payload = JSON.parse(await readFile(filename, 'utf8')); } catch { throw modeError('MODE_CONTEXT_INVALID'); }
    if (!payload || payload.version !== 1 || Object.keys(payload).sort().join(',') !== 'contexts,version'
        || !payload.contexts || typeof payload.contexts !== 'object' || Array.isArray(payload.contexts)) throw modeError('MODE_CONTEXT_INVALID');
    for (const [threadId, bindings] of Object.entries(payload.contexts)) {
      validateThread(threadId); contexts.set(threadId, validateBindings(bindings));
    }
  }
  let tail = Promise.resolve();
  const update = mutate => {
    const operation = tail.catch(() => undefined).then(async () => {
      const next = new Map(contexts);
      if (!mutate(next)) return false;
      const content = JSON.stringify({ version: 1, contexts: Object.fromEntries(next) }) + '\n';
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw modeError('MODE_CONTEXT_TOO_LARGE');
      const temporary = path.join(directory, `.mode-contexts.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
        await chown(temporary, uid, gid); await rename(temporary, filename);
        contexts.clear(); for (const [key, value] of next) contexts.set(key, value);
      } finally { await unlink(temporary).catch(() => undefined); }
      return true;
    });
    tail = operation; return operation;
  };
  return {
    get(threadId, server) {
      const value = contexts.get(threadId)?.[server];
      return value === null || value === undefined ? value : { ...value };
    },
    set(threadId, bindings) {
      validateThread(threadId);
      const copy = validateBindings(bindings);
      return update(next => { next.set(threadId, copy); return true; });
    },
    relocate(threadId, server, previousBinding, nextBinding) {
      validateThread(threadId);
      const previous = validateBindings({ [server]: previousBinding })[server];
      const target = validateBindings({ [server]: nextBinding })[server];
      if (!previous || !target || target.profileId !== previous.profileId || target.sessionKey !== threadId) throw modeError('MODE_CONTEXT_INVALID');
      return update(next => {
        const existing = next.get(threadId), current = existing?.[server];
        if (!current || current.profileId !== previous.profileId || current.sessionKey !== previous.sessionKey) return false;
        next.set(threadId, { ...existing, [server]: target }); return true;
      });
    },
  };
}
