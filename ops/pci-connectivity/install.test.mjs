import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeManagedBlock } from './install.mjs';
import { relayArguments } from './windows-relay.mjs';

test('managed include preserves previous SSH configuration', () => {
  const previous = 'Host original\n  HostName example.test\n';
  const next = mergeManagedBlock(previous, 'Include /safe/peers.conf');
  assert.ok(next.endsWith(previous));
  assert.equal(mergeManagedBlock(next, 'Include /safe/peers.conf'), next);
});
test('managed configuration rejects conflicting or incomplete ownership', () => {
  const previous = mergeManagedBlock('', 'Include /safe/peers.conf');
  assert.throws(() => mergeManagedBlock(previous, 'Include /other/file'));
  assert.throws(() => mergeManagedBlock('# BEGIN code-ai-pci-connectivity-v1\n', 'Include /safe/peers.conf'));
});
test('remote shell text is one argument after a fixed destination, not a local command', () => {
  const command = 'echo hello & whoami; $(not_a_local_command)';
  const args = relayArguments(command);
  assert.deepEqual(args.slice(-3), ['--', 'personal-windows-ssh', command]);
  assert.ok(args.includes('ClearAllForwardings=yes'));
  assert.ok(args.includes('ForwardAgent=no'));
});
test('interactive relay keeps stdin and oversized/NUL commands are rejected', () => {
  assert.equal(relayArguments('').at(-1), 'personal-windows-ssh');
  assert.throws(() => relayArguments('bad\0command'));
  assert.throws(() => relayArguments('x'.repeat(65537)));
});
