import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCodexInvocationArgs,
  sanitizeCodexCliFailure,
  type CodexProfile,
} from './codexService.js';

const profile: CodexProfile = {
  id: 'developer',
  label: 'Developer',
  provider: 'codex',
  codexHome: '/home/developer/.codex',
  workspaceCwd: '/srv/workspace',
};

test('active-writer conflicts identify the exact conversation without blocking the profile', () => {
  const message = sanitizeCodexCliFailure(
    profile,
    'Failed to create session: thread-store conflict: thread 019fedcd-32f3-7810-9c0e-d40881ea5cee already has an active writer',
    'Codex failed'
  );

  assert.match(message, /conversation "019fedcd-32f3-7810-9c0e-d40881ea5cee" is already open/i);
  assert.match(message, /only this conversation is locked/i);
  assert.match(message, /other conversations remain available/i);
  assert.doesNotMatch(message, /profile "Developer" is already active/i);
  assert.doesNotMatch(message, /chown|not writable|owned correctly/i);
});

test('active-writer conflicts without a thread id still describe a conversation-scoped lock', () => {
  const message = sanitizeCodexCliFailure(
    profile,
    'The selected thread already has an active writer',
    'Codex failed'
  );

  assert.match(message, /this Codex conversation is already open/i);
  assert.match(message, /only this conversation is locked/i);
});

test('generic session creation errors are not rewritten as permission errors', () => {
  const rawMessage = 'Failed to create session: invalid session metadata';
  assert.equal(sanitizeCodexCliFailure(profile, rawMessage, 'Codex failed'), rawMessage);
});

test('real permission errors avoid unsafe ownership commands and inherited USER labels', () => {
  const previousUser = process.env.USER;
  process.env.USER = 'developer';
  try {
    const message = sanitizeCodexCliFailure(
      profile,
      'Permission denied (os error 13)',
      'Codex failed'
    );

    assert.match(message, /cannot read or write/i);
    assert.doesNotMatch(message, /chown|server user "developer"/i);
  } finally {
    if (previousUser === undefined) {
      delete process.env.USER;
    } else {
      process.env.USER = previousUser;
    }
  }
});

test('selected sessions always resume the same id with remote compaction v2', () => {
  const sessionId = '019f184c-f25b-7c30-aa24-6ddd98f49c5c';
  const args = buildCodexInvocationArgs(
    ['--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'danger-full-access'],
    sessionId,
    ['/tmp/screenshot.png'],
    { model: 'gpt-5.6-sol', reasoningEffort: 'max' }
  );

  assert.deepEqual(args.slice(0, 11), [
    '--dangerously-bypass-approvals-and-sandbox',
    '--sandbox',
    'danger-full-access',
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--config',
    'mcp_oauth_credentials_store="file"',
    '--enable',
    'remote_compaction_v2',
    'resume',
  ]);
  assert.equal(args.at(-2), sessionId);
  assert.equal(args.at(-1), '-');
  assert.equal(args.filter((arg) => arg === 'remote_compaction_v2').length, 1);
  assert.equal(args.some((arg) => /clone/i.test(arg)), false);
});

test('new sessions use the same v2 invocation owner without resume', () => {
  const args = buildCodexInvocationArgs([], undefined, [], null);
  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--config',
    'mcp_oauth_credentials_store="file"',
    '--enable',
    'remote_compaction_v2',
    '-',
  ]);
});
