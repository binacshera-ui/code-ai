/** Private recovery copy for the one owner-requested BEAM conversation. No deletion. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
if (os.hostname() !== 'beam-10g') throw Error('Wrong host');
const id = '01a12cf1-70f9-75c1-978a-ca49cd084253';
const source = '/home/beamadmin/.codex/sessions/2026/10/11/rollout-2026-10-11T21-49-43-' + id + '.jsonl';
const directory = '/var/lib/code-ai-remote/beam-10g/deletion-recovery/20261012/' + id;
const before = await fs.lstat(source);
if (!before.isFile() || before.isSymbolicLink()) throw Error('Not an original transcript');
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
await fs.chmod(directory, 0o700);
const target = path.join(directory, 'rollout.jsonl');
try { await fs.copyFile(source, target, constants.COPYFILE_EXCL); }
catch (e) { if (e.code !== 'EEXIST') throw e; }
await fs.chmod(target, 0o600);
const [a, b, after] = await Promise.all([fs.readFile(source), fs.readFile(target), fs.lstat(source)]);
if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !a.equals(b)) {
  throw Error('Transcript changed; preserve copies and do not delete');
}
const rawIndex = await fs.readFile('/home/beamadmin/.codex/session_index.jsonl', 'utf8').catch(e => {
  if (e.code === 'ENOENT') return ''; throw e;
});
const lines = rawIndex.split('\n').filter(line => {
  try { return JSON.parse(line).id === id; } catch { return false; }
});
await fs.writeFile(path.join(directory, 'index-entries.jsonl'), lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
const state = JSON.parse(await fs.readFile('/var/lib/code-ai-remote/beam-10g/queue/state.json', 'utf8'));
const items = (state.items || []).filter(x => x.sessionId === id);
await fs.writeFile(path.join(directory, 'queue-items.json'), JSON.stringify({ sessionId: id, items }), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ format: 'code-ai-single-session-recovery', hostname: os.hostname(), sessionId: id, observedAt: new Date().toISOString(), recoveryDirectory: directory,
  transcriptCopiedAndByteCompared: true, transcriptBytes: after.size, transcriptMode: '0600', directoryMode: '0700', indexEntries: lines.length, queueItemCount: items.length,
  deleted: false, interrupted: false, credentialsRead: false, unrelatedSessionsCopied: false }));
