export interface TimelinePresentationEntry {
  id: string;
  entryType: 'message' | 'tool' | 'status';
  status?: string | null;
}

export type TimelineRenderBlock<TEntry extends TimelinePresentationEntry> =
  | { type: 'entry'; entry: TEntry }
  | { type: 'tool-row'; id: string; entries: TEntry[] };

export function isHiddenTaskLifecycleEntry(entry: TimelinePresentationEntry): boolean {
  return entry.entryType === 'status'
    && (entry.status === 'started' || entry.status === 'completed');
}

export function buildTimelineRenderBlocks<TEntry extends TimelinePresentationEntry>(
  timeline: TEntry[]
): TimelineRenderBlock<TEntry>[] {
  const blocks: TimelineRenderBlock<TEntry>[] = [];
  let pendingTools: TEntry[] = [];

  const flushPendingTools = () => {
    if (pendingTools.length === 0) {
      return;
    }

    blocks.push({
      type: 'tool-row',
      id: `${pendingTools[0]?.id || 'tool'}-${pendingTools[pendingTools.length - 1]?.id || pendingTools.length}`,
      entries: pendingTools,
    });
    pendingTools = [];
  };

  for (const entry of timeline) {
    if (entry.entryType === 'tool') {
      pendingTools.push(entry);
      continue;
    }

    flushPendingTools();
    if (isHiddenTaskLifecycleEntry(entry)) {
      continue;
    }
    blocks.push({ type: 'entry', entry });
  }

  flushPendingTools();
  return blocks;
}

export function flattenTimelineRenderBlocks<TEntry extends TimelinePresentationEntry>(
  blocks: TimelineRenderBlock<TEntry>[]
): TEntry[] {
  return blocks.flatMap((block) => (
    block.type === 'tool-row' ? block.entries : [block.entry]
  ));
}
