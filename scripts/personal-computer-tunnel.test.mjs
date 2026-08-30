import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReverseForwardArgs,
  readOptionalTunnelPort,
} from './personal-computer-tunnel.mjs';

test('keeps the existing API tunnel bound to control-plane loopback', () => {
  assert.deepEqual(
    buildReverseForwardArgs({
      apiReversePort: 44_001,
      sidecarPort: 4_010,
    }),
    ['-R', '127.0.0.1:44001:127.0.0.1:4010']
  );
});

test('adds a separate loopback-only SSH reverse tunnel', () => {
  assert.deepEqual(
    buildReverseForwardArgs({
      apiReversePort: 44_001,
      sidecarPort: 4_010,
      sshReversePort: 44_022,
      sshLocalPort: 22,
    }),
    [
      '-R',
      '127.0.0.1:44001:127.0.0.1:4010',
      '-R',
      '127.0.0.1:44022:127.0.0.1:22',
    ]
  );
});

test('rejects conflicting or invalid ports', () => {
  assert.equal(readOptionalTunnelPort('', 'optional'), null);
  assert.throws(
    () => buildReverseForwardArgs({
      apiReversePort: 44_001,
      sidecarPort: 4_010,
      sshReversePort: 44_001,
    }),
    /must be different/
  );
  assert.throws(
    () => buildReverseForwardArgs({
      apiReversePort: 44_001,
      sidecarPort: 4_010,
      sshReversePort: 70_000,
    }),
    /valid TCP port/
  );
  assert.throws(
    () => buildReverseForwardArgs({
      apiReversePort: '44001-and-more',
      sidecarPort: 4_010,
    }),
    /valid TCP port/
  );
});
