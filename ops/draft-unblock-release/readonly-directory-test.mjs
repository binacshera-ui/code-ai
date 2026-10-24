import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, copyFile, rename, lstat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

assert.notEqual(process.getuid(), 0, 'Run as an unprivileged user to exercise filesystem policy');
const root = await mkdtemp(tmpdir() + '/code-ai-draft-readonly-test-');
const baseline = root + '/baseline';
const candidate = root + '/candidate';
await mkdir(baseline + '/dist', { recursive: true });
await writeFile(baseline + '/dist/server.js', 'original');
await writeFile(root + '/patch.mjs', 'patched');
await chmod(baseline + '/dist/server.js', 0o444);
await chmod(baseline + '/dist', 0o555);
execFileSync('cp', ['-al', baseline, candidate]);
await assert.rejects(copyFile(root + '/patch.mjs', candidate + '/dist/server.js.next'), { code: 'EACCES' });
const sourceDirectory = await lstat(baseline + '/dist');
const candidateDirectory = await lstat(candidate + '/dist');
assert.notEqual(candidateDirectory.ino, sourceDirectory.ino);
await chmod(candidate + '/dist', (candidateDirectory.mode & 0o777) | 0o200);
try {
  await copyFile(root + '/patch.mjs', candidate + '/dist/server.js.next', 1);
  await chmod(candidate + '/dist/server.js.next', 0o644);
  await rename(candidate + '/dist/server.js.next', candidate + '/dist/server.js');
} finally {
  await chmod(candidate + '/dist', candidateDirectory.mode & 0o777);
}
assert.equal(await readFile(baseline + '/dist/server.js', 'utf8'), 'original');
assert.equal(await readFile(candidate + '/dist/server.js', 'utf8'), 'patched');
assert.equal((await lstat(baseline + '/dist/server.js')).mode & 0o777, 0o444);
assert.equal((await lstat(baseline + '/dist')).mode & 0o777, 0o555);
assert.equal((await lstat(candidate + '/dist')).mode & 0o777, 0o555);
console.log(JSON.stringify({ readOnlyFailureReproduced: true, candidateReplacementPassed: true,
  baselineBytesAndModesPreserved: true, candidateDirectoryModeRestored: true, productionEffects: false }));
