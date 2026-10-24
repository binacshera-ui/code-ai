import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRpcTimeoutMs, publicRpcDiagnostic, validatePublicRpcDiagnostic } from './codexRpcDiagnostic.mjs';
test('large history reads have a bounded two-minute budget; mutations retain short custody deadlines', () => {
  for (const method of ['thread/resume', 'thread/read', 'thread/turns/list', 'thread/items/list']) assert.equal(nativeRpcTimeoutMs(method), 120000);
  for (const method of ['thread/queue/add', 'turn/start', 'thread/settings/update', 'initialize', 'unknown']) assert.equal(nativeRpcTimeoutMs(method), 15000);
});
test('native failure classification never echoes arbitrary messages, credentials, parameters or method names', () => {
  const secret = 'private-test-marker';
  for (const [message, reason] of [['request timed out', 'native-read-timeout'], ['failed to load workspace requirements', 'workspace-requirements'],
    ['invalid type string expected u32', 'configuration-invalid'], ['access token could not be refreshed; sign in again', 'authentication-refresh'],
    ['already has an active writer', 'thread-writer-conflict'], ['Native connection lost', 'native-connection-lost']]) {
    const diagnostic = publicRpcDiagnostic('thread/resume', -32603, message + ' token=' + secret, 18.5);
    assert.equal(diagnostic.reason, reason); assert.equal(diagnostic.elapsedMs, 19);
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  }
  assert.equal(publicRpcDiagnostic(secret, -32603, secret).operation, 'other');
});
test('peer diagnostics are closed enums with allowlisted fields only', () => {
  assert.equal(validatePublicRpcDiagnostic({ version: 1, operation: 'thread/resume', reason: 'arbitrary secret' }), null);
  const d = validatePublicRpcDiagnostic({ ...publicRpcDiagnostic('thread/resume', -32603, 'request timed out'), prompt: 'private-test-marker', elapsedMs: Infinity });
  assert.equal(JSON.stringify(d).includes('private-test-marker'), false); assert.equal(d.elapsedMs, 0);
});
