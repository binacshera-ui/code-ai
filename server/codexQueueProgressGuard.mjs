/** A once-per-durable-native-turn claim; no commands/output are stored. */
export async function claimQueueProgressGuard(item, warning, persist) {
  if (item.status !== 'running' || item.nativeCancellationRequestedAt
      || (item.nativeSubmission && (item.nativeSubmission.deliveryPhase !== 'running'
        || item.nativeSubmission.turnId !== warning.turnId))
      || typeof warning.turnId !== 'string' || !warning.turnId
      || item.progressGuardWarning?.turnId === warning.turnId
      || warning.kind !== 'repeated_failure'
      || !/^[a-f0-9]{64}$/.test(warning.fingerprint)
      || !Number.isInteger(warning.count) || warning.count < 2 || warning.count > 10) return false;
  const record = { kind: warning.kind, turnId: warning.turnId, fingerprint: warning.fingerprint,
    count: warning.count, intervention: 'claimed', at: new Date().toISOString() };
  item.progressGuardWarning = record;
  try {
    await persist();
    return true;
  } catch {
    // Never steer without durable custody. Keep the in-memory claim as well:
    // a later unrelated successful persist must not allow a duplicate steer.
    return false;
  }
}
