import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const fields = [
  ['deviceAdminPassword', 'CODEX_DEVICE_ADMIN_PASSWORD'],
  ['sessionSecret', 'SESSION_SECRET'],
];
const refused = reason => Object.assign(new Error('Existing runtime authentication could not be preserved.'), { reason });

// Parse privately: PM2's nested env object is not necessarily the complete
// environment actually inherited by its currently installed child process.
export function parseRuntimeEnvironment(bytes) {
  const environment = {};
  for (const entry of bytes.toString('utf8').split('\0')) {
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator < 1) throw refused('runtime_environment_shape_changed');
    const name = entry.slice(0, separator);
    // PM2 must create fresh IPC descriptors for a new child. Kernel environ
    // still contains the old descriptors even after Node removes them from
    // process.env; forwarding those to the PM2 CLI is not safe inheritance.
    if (['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID'].includes(name)) continue;
    environment[name] = entry.slice(separator + 1);
  }
  return environment;
}

// No secret is embedded, returned, hashed separately, or logged. Missing env
// defaults are taken privately from the pinned, untouched installed predecessor.
// This preserves its credential values; it neither rotates nor invents them.
export async function preserveRuntimeAuthentication(env = process.env) {
  const missing = fields.filter(([, name]) => !env[name]);
  if (!missing.length) return { preserved: true, fields: fields.map(([, name]) => ({ name, source: 'environment' })) };
  const file = env.CODE_AI_AUTH_BASELINE_MODULE;
  const expected = env.CODE_AI_AUTH_BASELINE_SHA256;
  if (!file || !path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expected || '')) throw refused('pinned_auth_baseline_required');
  let bytes;
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024 || (metadata.mode & 0o002)) throw refused('unsafe_auth_baseline');
    bytes = await readFile(file);
  } catch { throw refused('auth_baseline_unavailable'); }
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw refused('auth_baseline_changed');
  const source = bytes.toString('utf8');
  const parsed = [];
  for (const [field, name] of missing) {
    const pattern = new RegExp('\\b' + field + ':\\s*process\\.env\\.' + name + '\\s*\\|\\|\\s*("(?:\\\\.|[^"\\\\])*")', 'g');
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) throw refused('auth_default_shape_changed');
    let value;
    try { value = JSON.parse(matches[0][1]); } catch { throw refused('auth_default_shape_changed'); }
    if (typeof value !== 'string' || !value) throw refused('auth_default_shape_changed');
    parsed.push([name, value]);
  }
  // Commit only after the entire requested default closure validates.
  for (const [name, value] of parsed) env[name] = value;
  return { preserved: true, fields: fields.map(([, name]) => ({ name,
    source: missing.some(([, absent]) => absent === name) ? 'pinned_predecessor_default' : 'environment' })) };
}
