export type TranscriptScrollMode = 'follow-live' | 'reading-history';

export type TranscriptMutation = 'reset' | 'prepend' | 'append-or-update';

const UPWARD_SCROLL_EPSILON_PX = 2;
const RESUME_FOLLOW_DISTANCE_PX = 48;
const HISTORY_PREFETCH_MIN_DISTANCE_PX = 480;
const HISTORY_PREFETCH_VIEWPORT_MULTIPLIER = 1.25;

export function resolveTranscriptScrollIntent(input: {
  mode: TranscriptScrollMode;
  previousScrollTop: number;
  scrollTop: number;
  distanceFromBottom: number;
}): {
  mode: TranscriptScrollMode;
  enteredReadingMode: boolean;
} {
  const scrolledUp = input.scrollTop < input.previousScrollTop - UPWARD_SCROLL_EPSILON_PX;
  if (scrolledUp) {
    return {
      mode: 'reading-history',
      enteredReadingMode: input.mode !== 'reading-history',
    };
  }

  if (input.distanceFromBottom <= RESUME_FOLLOW_DISTANCE_PX) {
    return {
      mode: 'follow-live',
      enteredReadingMode: false,
    };
  }

  return {
    mode: input.mode,
    enteredReadingMode: false,
  };
}

export function shouldRequestEarlierTimeline(input: {
  mode: TranscriptScrollMode;
  enteredReadingMode: boolean;
  scrollTop: number;
  clientHeight: number;
  hasEarlierTimeline: boolean;
  isLoading: boolean;
}): boolean {
  if (
    input.mode !== 'reading-history'
    || !input.hasEarlierTimeline
    || input.isLoading
  ) {
    return false;
  }

  const prefetchDistance = Math.max(
    HISTORY_PREFETCH_MIN_DISTANCE_PX,
    input.clientHeight * HISTORY_PREFETCH_VIEWPORT_MULTIPLIER,
  );
  return input.enteredReadingMode || input.scrollTop <= prefetchDistance;
}

export function classifyTranscriptMutation(input: {
  previousConversationKey: string;
  nextConversationKey: string;
  previousFirstEntryId: string | null;
  nextFirstEntryId: string | null;
  previousFirstEntryStillRendered: boolean;
}): TranscriptMutation {
  if (
    !input.previousConversationKey
    || input.previousConversationKey !== input.nextConversationKey
  ) {
    return 'reset';
  }

  if (
    input.previousFirstEntryId
    && input.nextFirstEntryId !== input.previousFirstEntryId
    && input.previousFirstEntryStillRendered
  ) {
    return 'prepend';
  }

  return 'append-or-update';
}

export function resolveScrollTopAfterTimelineChange(input: {
  mode: TranscriptScrollMode;
  mutation: TranscriptMutation;
  previousScrollTop: number;
  previousScrollHeight: number;
  nextScrollHeight: number;
  clientHeight: number;
}): number {
  const maximumScrollTop = Math.max(0, input.nextScrollHeight - input.clientHeight);
  if (input.mode === 'follow-live' || input.mutation === 'reset') {
    return maximumScrollTop;
  }

  if (input.mutation === 'prepend') {
    const heightDelta = input.nextScrollHeight - input.previousScrollHeight;
    return Math.min(maximumScrollTop, Math.max(0, input.previousScrollTop + heightDelta));
  }

  return Math.min(maximumScrollTop, Math.max(0, input.previousScrollTop));
}

export function mergeEarlierTimelineEntries<T extends { id: string }>(
  earlierEntries: T[],
  currentEntries: T[],
): T[] {
  const knownIds = new Set(currentEntries.map((entry) => entry.id));
  const prefix: T[] = [];
  for (const entry of earlierEntries) {
    if (knownIds.has(entry.id)) {
      continue;
    }
    knownIds.add(entry.id);
    prefix.push(entry);
  }
  return [...prefix, ...currentEntries];
}
