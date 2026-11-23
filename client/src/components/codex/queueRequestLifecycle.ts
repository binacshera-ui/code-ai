export interface QueueRequestTicket {
  scope: string;
  epoch: number;
}

/** Background summaries are bounded; explicitly opened queue details preserve
 * the existing full-history contract, including old failures and cancellations. */
export function queueListViewForPanel(stage: 'closed' | 'summary' | 'details', history?: boolean) {
  return (history ?? stage === 'details') ? 'full' : 'compact';
}

/** A list read must not replace a newer read, a durable acknowledgement, or a
 * different conversation. Epochs also reject leave-and-return navigation. */
export function createQueueRequestScope() {
  let scope = '';
  let epoch = 0;
  let revision = 0;
  let latestRead = 0;
  const current = (ticket: QueueRequestTicket | null) => Boolean(ticket
    && ticket.scope === scope && ticket.epoch === epoch);
  return {
    setScope(next: string) {
      if (next !== scope) { scope = next; epoch++; revision++; }
    },
    capture(expected: string): QueueRequestTicket | null {
      return expected === scope ? { scope, epoch } : null;
    },
    current,
    beginRead(expected: string) {
      const ticket = expected === scope ? { scope, epoch } : null;
      return ticket ? { ...ticket, revision, read: ++latestRead } : null;
    },
    acceptRead(ticket: QueueRequestTicket & { revision: number; read: number }) {
      return current(ticket) && ticket.revision === revision && ticket.read === latestRead;
    },
    acknowledged(ticket: QueueRequestTicket | null) {
      if (!current(ticket)) return false;
      revision++;
      return true;
    },
  };
}

interface SubmissionOptions<T> {
  fingerprint: string;
  createRequestId: () => string;
  request: (clientRequestId: string) => Promise<T | null>;
  accepted: (value: T) => void;
  failed: (error: unknown) => void;
  sending: (value: boolean) => void;
  refresh: () => Promise<unknown> | void;
  backgroundFailed: (error: unknown) => void;
}

/** One explicit submission at a time. Lost/invalid acknowledgements retain the
 * exact request ID for an explicit retry of that payload, without a short TTL.
 * Refresh is deliberately outside both the sending lock and the send-error
 * boundary: a saved message cannot become a failed send because a GET failed. */
export function createDurableQueueSubmission() {
  let inFlight = false;
  const unresolvedRequestIds = new Map<string, string>();
  return {
    get inFlight() { return inFlight; },
    async run<T>(options: SubmissionOptions<T>): Promise<boolean> {
      if (inFlight) return false;
      inFlight = true;
      options.sending(true);
      let acknowledged = false;
      try {
        const previousRequestId = unresolvedRequestIds.get(options.fingerprint);
        const requestId = previousRequestId || options.createRequestId();
        unresolvedRequestIds.set(options.fingerprint, requestId);
        const value = await options.request(requestId);
        if (value === null) {
          // This attempt did not submit, but an earlier attempt with the same
          // payload may still have an ambiguous acknowledgement to preserve.
          if (!previousRequestId) unresolvedRequestIds.delete(options.fingerprint);
          return false;
        }
        acknowledged = true;
        unresolvedRequestIds.delete(options.fingerprint);
        options.accepted(value);
      } catch (error) {
        if (acknowledged) options.backgroundFailed(error);
        else options.failed(error);
      } finally {
        inFlight = false;
        options.sending(false);
      }
      if (acknowledged) {
        // Defer even the synchronous beginning of refresh until the accepted
        // composer state and unlocked button have been scheduled.
        void Promise.resolve().then(options.refresh).catch(options.backgroundFailed);
      }
      return acknowledged;
    },
  };
}

/** Remove only the attachments included in this acknowledged request. Files
 * added while the request was in flight belong to the next draft. */
export function removeAcknowledgedAttachments<T extends { id: string; previewUrl?: string | null }>(
  current: T[], acknowledgedIds: ReadonlySet<string>, revoke: (url: string) => void,
): T[] {
  return current.filter(attachment => {
    if (!acknowledgedIds.has(attachment.id)) return true;
    if (attachment.previewUrl) revoke(attachment.previewUrl);
    return false;
  });
}
