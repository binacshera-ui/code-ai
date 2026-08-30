import type { CodexSessionDetail, CodexTimelineEntry } from './codexService.js';

export const DEFAULT_CLIENT_TIMELINE_BUDGET_BYTES = 384 * 1024;
export const DEFAULT_CLIENT_TOOL_FIELD_BUDGET_BYTES = 96 * 1024;

const TRUNCATION_MARKER = '\n\n[Long tool content was shortened for fast display. The original remains in the Codex session.]';

function clipUtf8Text(value: string | null | undefined, maxBytes: number): string | null | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= contentBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return `${value.slice(0, low)}${TRUNCATION_MARKER}`;
}

function compactTimelineEntry(
  entry: CodexTimelineEntry,
  maxToolFieldBytes: number
): CodexTimelineEntry {
  if (entry.entryType !== 'tool') {
    return entry;
  }

  const toolInputText = clipUtf8Text(entry.toolInputText, maxToolFieldBytes);
  const toolOutputText = clipUtf8Text(entry.toolOutputText, maxToolFieldBytes);
  const hasStructuredToolContent = Boolean(toolInputText?.trim() || toolOutputText?.trim());
  const compactedText = hasStructuredToolContent
    ? undefined
    : clipUtf8Text(entry.text, maxToolFieldBytes);

  if (
    toolInputText === entry.toolInputText
    && toolOutputText === entry.toolOutputText
    && compactedText === entry.text
  ) {
    return entry;
  }

  return {
    ...entry,
    text: compactedText ?? undefined,
    toolInputText,
    toolOutputText,
  };
}

export function prepareSessionDetailForClient(
  session: CodexSessionDetail,
  options: {
    maxTimelineBytes?: number;
    maxToolFieldBytes?: number;
  } = {}
): CodexSessionDetail {
  const maxTimelineBytes = Math.max(
    32 * 1024,
    options.maxTimelineBytes || DEFAULT_CLIENT_TIMELINE_BUDGET_BYTES
  );
  const maxToolFieldBytes = Math.max(
    8 * 1024,
    options.maxToolFieldBytes || DEFAULT_CLIENT_TOOL_FIELD_BUDGET_BYTES
  );
  const compactedTimeline = session.timeline.map((entry) => (
    compactTimelineEntry(entry, maxToolFieldBytes)
  ));

  let retainedStart = compactedTimeline.length;
  let retainedBytes = 2;
  for (let index = compactedTimeline.length - 1; index >= 0; index -= 1) {
    const entryBytes = Buffer.byteLength(JSON.stringify(compactedTimeline[index]), 'utf8') + 1;
    if (retainedStart < compactedTimeline.length && retainedBytes + entryBytes > maxTimelineBytes) {
      break;
    }
    retainedStart = index;
    retainedBytes += entryBytes;
  }

  const timeline = compactedTimeline.slice(retainedStart);
  const removedEntryCount = session.timeline.length - timeline.length;
  const timelineWindowStart = Math.min(
    session.timelineWindowEnd,
    session.timelineWindowStart + removedEntryCount
  );

  return {
    ...session,
    // The client renders the timeline. Returning messages as well duplicates
    // the largest strings and can double the JSON parse cost on mobile.
    messages: [],
    timeline,
    timelineWindowStart,
    hasEarlierTimeline: timelineWindowStart > 0,
  };
}
