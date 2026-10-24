/** Preserve only the clarified failed placeholder; never touch native history. */
import fs from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert/strict';
if (os.hostname() !== 'beam-10g') throw Error('Wrong host');
const id = 'a0d211b7-8d32-452e-9116-03420ad6bffa';
const key = 'draft-42f3bf07-a2d7-4f56-bc4f-f371d72b27cc';
const state = JSON.parse(await fs.readFile('/var/lib/code-ai-remote/beam-10g/queue/state.json', 'utf8'));
const rows = state.items.filter(x => x.queueKey === key);
assert.equal(rows.length, 1, 'Expected one placeholder only');
const item = rows[0];
assert.equal(item.id, id); assert.equal(item.profileId, 'beam-admin');
assert.equal(item.status, 'failed'); assert.equal(item.sessionId, null);
assert.ok(!item.nativeSubmission); assert.equal(item.error, 'MODE_PROGRAM_UNAVAILABLE');
assert.ok(item.promptPreview.startsWith('תתחבר לשרת בגרמניה'));
const directory = '/var/lib/code-ai-remote/beam-10g/deletion-recovery/20261012/queue-' + id;
await fs.mkdir(directory, { mode: 0o700, recursive: true });
await fs.chmod(directory, 0o700);
const target = directory + '/queue-item.json';
const serialized = JSON.stringify({ format: 'code-ai-failed-placeholder-recovery', version: 1, item }, null, 2);
try { await fs.writeFile(target, serialized, { mode: 0o600, flag: 'wx' }); }
catch (e) { if (e.code !== 'EEXIST') throw e; }
await fs.chmod(target, 0o600);
assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')).item, item, 'Private recovery mismatch');
const owner = JSON.parse(await fs.readFile('/home/beamadmin/code-ai-native-owner/ownership.json', 'utf8'));
console.log(JSON.stringify({ sessionId: null, queueItemId: id, queueKey: key, status: item.status, nativeSubmission: false, privateRecoveryVerified: true, recoveryDirectory: directory,
  beforeQueueItems: state.items.map(x => ({ id: x.id, status: x.status, sessionId: x.sessionId, queueKey: x.queueKey })),
  nativePid: owner.nativePid, nativeStartTime: owner.nativeIdentity.startTime,
  nativeTranscriptTouched: false, observedAt: new Date().toISOString() }));
