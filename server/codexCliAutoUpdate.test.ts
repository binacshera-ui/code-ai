import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareStableVersions,
  inferPosixNpmPrefixFromCodexPath,
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
