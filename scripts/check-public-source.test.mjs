import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-public-source.mjs', import.meta.url));
function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'code-ai-public-source-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function check(root, env = {}) {
  return spawnSync(process.execPath, [checker], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, CODE_AI_PRIVATE_IDENTIFIERS_FILE: '', ...env },
  });
}

test('safe public examples and ignored private state are accepted', () => fixture(root => {
  writeFileSync(path.join(root, '.gitignore'), '.private/\n');
  mkdirSync(path.join(root, '.private'));
  writeFileSync(path.join(root, '.private', 'runtime'), 'operator-only data');
  writeFileSync(path.join(root, 'README.md'), 'Use /home/example/.codex and https://github.com/example/project.');
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).publicSourceCheck, 'passed');
}));

test('an accidentally published operator script fails the gate', () => fixture(root => {
  mkdirSync(path.join(root, 'ops'));
  writeFileSync(path.join(root, 'ops', 'host.mjs'), 'export const value = 1;');
  const result = check(root);
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stderr).findings.some(item => item.rule === 'private-source-path'));
}));

test('credentials and operator home paths are reported without their values', () => fixture(root => {
  const credential = 'ghp_' + 'A'.repeat(40);
  const privatePath = ['', 'home', 'private-operator', '.ssh', 'config'].join('/');
  writeFileSync(path.join(root, 'config.txt'), `${credential}\n${privatePath}\n`);
  const result = check(root);
  assert.equal(result.status, 1);
  const findings = JSON.parse(result.stderr).findings;
  assert.ok(findings.some(item => item.rule === 'provider-key'));
  assert.ok(findings.some(item => item.rule === 'operator-home'));
  assert.ok(!result.stderr.includes(credential) && !result.stderr.includes(privatePath));
}));

test('a publication cannot follow a symlink to private data', () => fixture(root => {
  mkdirSync(path.join(root, '.private'));
  writeFileSync(path.join(root, '.gitignore'), '.private/\n');
  writeFileSync(path.join(root, '.private', 'secret'), 'PRIVATE_CONTENT_MUST_NOT_BE_READ');
  symlinkSync('.private/secret', path.join(root, 'leak.txt'));
  const result = check(root);
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stderr).findings.some(item => item.rule === 'published-symlink'));
  assert.ok(!result.stderr.includes('PRIVATE_CONTENT_MUST_NOT_BE_READ'));
}));

test('private policy detects local identifiers while allowing the public repository URL', () => fixture(root => {
  const identifier = 'private' + '-organization';
  mkdirSync(path.join(root, '.private'));
  writeFileSync(path.join(root, '.gitignore'), '.private/\n');
  const policy = path.join(root, '.private', 'identifiers');
  writeFileSync(policy, identifier);
  const doc = path.join(root, 'README.md');
  writeFileSync(doc, `https://github.com/${identifier}/project`);
  assert.equal(check(root, { CODE_AI_PRIVATE_IDENTIFIERS_FILE: policy }).status, 0);
  writeFileSync(doc, `${identifier} internal deployment`);
  const result = check(root, { CODE_AI_PRIVATE_IDENTIFIERS_FILE: policy });
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stderr).findings.some(item => item.rule === 'operator-private-identifier'));
  assert.ok(!result.stderr.includes(identifier));
}));
