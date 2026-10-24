import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync('input-manifest.json', 'utf8'));
for (const [file, digest] of Object.entries(manifest.files)) {
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), digest, `Input digest: ${file}`);
}
assert.ok(existsSync('payload/prebuilt/server.js'));
assert.ok(existsSync('payload/package-lock.json'));
assert.equal(execFileSync('payload/codex-vendor/bin/codex', ['--version'], {encoding:'utf8'}).trim(), 'codex-cli 0.160.1');
console.log('Accepted server artifact and pinned native CLI input digests verified.');
