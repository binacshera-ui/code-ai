import {mkdtemp,writeFile,readFile,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkForCodexCliUpdate,
  compareStableVersions,
  inferPosixNpmPrefixFromCodexPath,
  isCodexCliInstallRequired,
  parseCodexCliVersion,
} from './codexCliAutoUpdate.js';

test('parses Codex CLI versions from command output', () => {
  assert.equal(parseCodexCliVersion('codex-cli 0.153.4'), '0.153.4');
  assert.equal(parseCodexCliVersion('0.154.0-alpha.3'), '0.154.0-alpha.3');
  assert.equal(parseCodexCliVersion('unknown'), null);
});

test('compares stable Codex versions numerically', () => {
  assert.equal(compareStableVersions('0.153.4', '0.153.4'), 0);
  assert.ok(compareStableVersions('0.153.4', '0.147.0') > 0);
  assert.ok(compareStableVersions('0.99.0', '0.100.0') < 0);
});

test('repairs a missing Codex executable even when the package is already installed', () => {
  assert.equal(isCodexCliInstallRequired(null, '0.156.0'), true);
  assert.equal(isCodexCliInstallRequired('0.155.0', '0.156.0'), true);
  assert.equal(isCodexCliInstallRequired('0.156.0', '0.156.0'), false);
  assert.equal(isCodexCliInstallRequired('0.162.1', '0.154.0'), false);
});

test('infers the npm prefix from resolved Linux Codex package paths', () => {
  assert.equal(
    inferPosixNpmPrefixFromCodexPath('/usr/lib/node_modules/@openai/codex/bin/codex.js'),
    '/usr',
  );
  assert.equal(
    inferPosixNpmPrefixFromCodexPath('/usr/local/lib/node_modules/@openai/codex/bin/codex.js'),
    '/usr/local',
  );
  assert.equal(inferPosixNpmPrefixFromCodexPath('/opt/tools/codex'), null);
});

for (const version of ['0.162.1', '0.163.0']) {
  test(`managed owner reports ${version === '0.163.0' ? 'current' : 'available'} without replacing its executable`, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-managed-update-'));
    const executable = path.join(directory, 'codex'), npm = path.join(directory, 'npm'), marker = path.join(directory, 'npm-was-run');
    const original = '#!/bin/sh\necho codex-cli ' + version + '\n';
    await writeFile(executable, original, {mode: 0o700});
    await writeFile(npm, '#!/bin/sh\nprintf unexpected > ' + marker + '\n', {mode: 0o700});
    const changes = {CODEX_BIN: executable, NPM_BIN: npm, CODEX_CLI_AUTO_UPDATE: '1', CODE_AI_CODEX_SHARED_OWNER_PROFILES: 'developer,developer2'};
    const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
    Object.assign(process.env, changes);
    t.after(() => {for (const [key,value] of Object.entries(previous)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}});
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({version: '0.163.0'}), {status: 200}));
    let callback = false;
    const snapshot = await checkForCodexCliUpdate(() => {callback = true;});
    assert.equal(snapshot.state, version === '0.163.0' ? 'current' : 'available');
    assert.equal(snapshot.currentVersion, version);assert.equal(snapshot.latestVersion, '0.163.0');assert.equal(snapshot.error, null);
    assert.equal(await readFile(executable, 'utf8'), original);
    assert.equal(await access(marker).then(() => true, () => false), false, 'npm must not replace a managed native executable');
    assert.equal(callback, false, 'no false installed-update callback');
  });
}
