/** Prevent stale reads, writes and finalizers crossing server/profile/session. */
export function createScopedPreferenceRequests() {
  let scope = '';
  let revision = 0;
  let saving = false;
  const current = (ticket: { scope: string; revision: number }) => ticket.scope === scope && ticket.revision === revision;
  return {
    setScope(next: string) { if (scope !== next) { scope = next; revision++; saving = false; } },
    beginRead(expected: string) {
      return saving || expected !== scope ? null : { scope, revision: ++revision };
    },
    beginWrite(expected: string) {
      if (saving || expected !== scope) return null;
      saving = true;
      return { scope, revision: ++revision };
    },
    current,
    finishWrite(ticket: { scope: string; revision: number }) { if (current(ticket)) saving = false; },
  };
}
