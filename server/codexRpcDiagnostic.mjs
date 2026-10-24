/** Public, closed-vocabulary RPC diagnostics. Native messages stay private. */
const slowReads = new Set(['thread/resume', 'thread/read', 'thread/turns/list', 'thread/items/list']);
const operations = new Set([...slowReads, 'initialize', 'thread/start', 'thread/queue/list',
  'thread/queue/add', 'thread/settings/update', 'turn/start', 'turn/steer', 'turn/interrupt',
  'config/read', 'configRequirements/read', 'account/read']);
export const rpcDiagnosticReasons = new Set(['native-read-timeout', 'native-write-timeout',
  'native-rejected', 'native-connection-lost', 'native-capacity-unavailable',
  'settings-observation-unavailable', 'workspace-requirements', 'configuration-invalid',
  'authentication-refresh', 'thread-writer-conflict', 'custody-unresolved', 'history-recovery-limit']);

export function nativeRpcTimeoutMs(method) { return slowReads.has(method) ? 120_000 : 15_000; }

export function publicRpcDiagnostic(method, code, message, elapsedMs = 0) {
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  const reason = /history.*(?:pagination|recovery budget)/.test(text) ? 'history-recovery-limit'
    : /workspace requirements/.test(text) ? 'workspace-requirements'
    : /invalid type|failed to parse.*config|failed to deserialize.*config/.test(text) ? 'configuration-invalid'
    : /token.*refresh|logged out|sign in again/.test(text) ? 'authentication-refresh'
    : /active writer|already.*writer|another codex process/.test(text) ? 'thread-writer-conflict'
    : /acknowledgement unavailable|request timed out/.test(text)
      ? slowReads.has(method) ? 'native-read-timeout' : 'native-write-timeout'
    : /connection lost/.test(text) ? 'native-connection-lost'
    : /capacity unavailable/.test(text) ? 'native-capacity-unavailable'
    : /settings.*observation/.test(text) ? 'settings-observation-unavailable'
    : Number.isInteger(code) ? 'native-rejected' : 'custody-unresolved';
  return { version: 1, operation: operations.has(method) ? method : 'other', reason,
    nativeCode: Number.isInteger(code) ? code : null,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.min(3_600_000, Math.round(elapsedMs))) : 0 };
}

export function validatePublicRpcDiagnostic(value) {
  if (!value || value.version !== 1 || !(operations.has(value.operation) || value.operation === 'other')
      || !rpcDiagnosticReasons.has(value.reason)) return null;
  // Reconstruct; never trust arbitrary extra fields from a transport peer.
  return { version: 1, operation: value.operation, reason: value.reason,
    nativeCode: Number.isInteger(value.nativeCode) ? value.nativeCode : null,
    elapsedMs: Number.isFinite(value.elapsedMs) ? Math.max(0, Math.min(3_600_000, Math.round(value.elapsedMs))) : 0 };
}
