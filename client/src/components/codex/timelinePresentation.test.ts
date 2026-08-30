import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTimelineRenderBlocks,
  flattenTimelineRenderBlocks,
  type TimelinePresentationEntry,
} from './timelinePresentation';

function entry(
  id: string,
  entryType: TimelinePresentationEntry['entryType'],
  status?: string
): TimelinePresentationEntry {
  return { id, entryType, status };
}

test('task start and completion events never become visible timeline rows', () => {
  const blocks = buildTimelineRenderBlocks([
    entry('tool-before', 'tool'),
    entry('turn-complete', 'status', 'completed'),
    entry('turn-start', 'status', 'started'),
    entry('tool-after', 'tool'),
  ]);

  assert.deepEqual(
    blocks.map((block) => (
      block.type === 'tool-row'
        ? { type: block.type, entries: block.entries.map((item) => item.id) }
        : { type: block.type, entry: block.entry.id }
    )),
    [
      { type: 'tool-row', entries: ['tool-before'] },
      { type: 'tool-row', entries: ['tool-after'] },
    ]
  );
});

test('hidden lifecycle events remain separators and do not merge tool groups', () => {
  const blocks = buildTimelineRenderBlocks([
    entry('tool-a', 'tool'),
    entry('turn-complete', 'status', 'completed'),
    entry('turn-start', 'status', 'started'),
    entry('tool-b', 'tool'),
  ]);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, 'tool-row');
  assert.equal(blocks[1]?.type, 'tool-row');
});

test('meaningful status rows stay visible and participate in the viewport signature', () => {
  const blocks = buildTimelineRenderBlocks([
    entry('turn-start', 'status', 'started'),
    entry('aborted', 'status', 'aborted'),
    entry('failed', 'status', 'failed'),
    entry('cancelled', 'status', 'cancelled'),
    entry('summary', 'status', 'summary-auto'),
    entry('turn-complete', 'status', 'completed'),
  ]);

  assert.deepEqual(
    flattenTimelineRenderBlocks(blocks).map((item) => item.id),
    ['aborted', 'failed', 'cancelled', 'summary']
  );
});
