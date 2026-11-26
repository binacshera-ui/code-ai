import { createScopedPreferenceRequests } from './scopedPreferenceRequests';

export type ComposerMessageEndpoint = '/api/codex/messages' | '/api/codex/queue/items' | '/api/codex/queue/drafts';

export function composerMessageEndpoint(input: {
  provider: string | null | undefined;
  saveAsDraft: boolean;
  scheduledFor: string;
  scheduleType: 'once' | 'recurring';
  supportsLiveInput?: boolean;
  activeConversation?: boolean;
  sessionBindingPending?: boolean;
}): ComposerMessageEndpoint {
  if (input.saveAsDraft) return '/api/codex/queue/drafts';
  // Capable servers decide atomically whether a normal send joins a native
  // turn or starts queued work; the running flag only guards legacy servers.
  if (input.provider === 'codex' && !input.scheduledFor && input.scheduleType === 'once') {
    if (input.sessionBindingPending) {
      throw new Error('השיחה הפעילה עדיין נטענת. הטיוטה נשמרה; אפשר לשלוח לאחר טעינת השיחה.');
    }
    if (input.supportsLiveInput) return '/api/codex/messages';
    if (input.supportsLiveInput === undefined) {
      throw new Error('לא ניתן לאמת את תמיכת השרת בשליחת הודעות כעת. הטיוטה נשמרה.');
    }
    if (input.activeConversation) {
      throw new Error('השרת הזה דורש עדכון לצירוף הודעה לריצה פעילה');
    }
  }
  return '/api/codex/queue/items';
}

export interface ComposerLiveInputCapability {
  supported: boolean;
  protocol: 'steer-context-v1';
}

/** A server/profile catalog capability must never leak to another connection,
 * including leave-and-return navigation while its old read is pending. */
export function createComposerLiveInputCapability() {
  const requests = createScopedPreferenceRequests();
  let scope = '', supported: boolean | undefined;
  return {
    setScope(next: string) {
      if (scope !== next) supported = undefined;
      scope = next;
      requests.setScope(next);
    },
    beginRead: requests.beginRead,
    accept(ticket: { scope: string; revision: number } | null, value: ComposerLiveInputCapability | null | undefined) {
      if (!ticket || !requests.current(ticket)) return false;
      supported = value?.supported === true && value.protocol === 'steer-context-v1';
      return true;
    },
    read(expectedScope: string) { return scope === expectedScope ? supported : undefined; },
  };
}

export interface ActiveTurnMessageDelivery {
  kind: 'active-turn';
  id: string;
  clientRequestId: string;
  profileId: string;
  sessionId: string;
  turnId: string;
  status: 'delivered';
}

export type ComposerMessageAcceptance<T> =
  | { kind: 'active-turn'; delivery: ActiveTurnMessageDelivery }
  | { kind: 'queued'; items: T[] };

export const ACTIVE_TURN_MESSAGE_NOTICE = 'ההודעה צורפה לריצה הפעילה';

/** Only a correlated, final acknowledgement may clear the original draft.
 * An active-turn delivery is not a queue row, including when refreshing fails. */
export function parseComposerMessageAcceptance<T extends { id: string }>(
  response: unknown,
  expected: {
    endpoint: ComposerMessageEndpoint;
    clientRequestId: string;
    profileId: string;
    sessionId: string | null;
  },
): ComposerMessageAcceptance<T> {
  const value = response && typeof response === 'object' ? response as Record<string, unknown> : null;
  if (value && 'delivery' in value) {
    const delivery = value.delivery && typeof value.delivery === 'object'
      ? value.delivery as Record<string, unknown> : null;
    if (expected.endpoint !== '/api/codex/messages'
      || !expected.sessionId
      || value.item !== undefined || value.items !== undefined
      || delivery?.kind !== 'active-turn' || delivery.status !== 'delivered'
      || typeof delivery.id !== 'string' || !delivery.id.trim()
      || delivery.clientRequestId !== expected.clientRequestId || delivery.profileId !== expected.profileId
      || delivery.sessionId !== expected.sessionId
      || typeof delivery.turnId !== 'string' || !delivery.turnId.trim()) {
      throw new Error('השרת לא אישר את מסירת ההודעה לריצה הפעילה. הטיוטה נשמרה.');
    }
    return { kind: 'active-turn', delivery: delivery as unknown as ActiveTurnMessageDelivery };
  }
  const items = value && Array.isArray(value.items) && value.items.length > 0
    ? value.items : value?.item ? [value.item] : [];
  if (!items.length || items.some(item => !item || typeof item !== 'object'
    || typeof (item as { id?: unknown }).id !== 'string' || !(item as { id: string }).id)) {
    throw new Error('השרת לא החזיר אישור שליחה תקין. הטיוטה נשמרה.');
  }
  return { kind: 'queued', items: items as T[] };
}

/** Keep an ambiguous write on its original endpoint, even if the capability
 * catalog changes before an explicit retry. Never fall back after a POST. */
export function createComposerMessageEndpointPins() {
  const pending = new Map<string, ComposerMessageEndpoint>();
  return {
    read: (requestId: string) => pending.get(requestId),
    pin(requestId: string, endpoint: ComposerMessageEndpoint) {
      const original = pending.get(requestId);
      if (original) return original;
      pending.set(requestId, endpoint);
      return endpoint;
    },
    release: (requestId: string) => pending.delete(requestId),
  };
}

export function composerMessageProvenNotDelivered(error: unknown, endpoint: ComposerMessageEndpoint | undefined): boolean {
  if (endpoint !== '/api/codex/messages' || !error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; status?: unknown };
  return value.status === 409 && (value.code === 'LIVE_TURN_ENDED' || value.code === 'LIVE_INPUT_REJECTED');
}
