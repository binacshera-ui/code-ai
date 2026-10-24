import assert from 'node:assert/strict';
import test from 'node:test';
import { createSendPressGesture, DRAFT_PRESS_DELAY_MS } from './sendPressGesture';

function fixture() {
  let saved = 0;
  let callback: (() => void) | null = null;
  const gesture = createSendPressGesture(() => saved++, {
    set: (next, delay) => {
      assert.equal(delay, DRAFT_PRESS_DELAY_MS);
      callback = next;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clear: () => { callback = null; },
  });
  return { gesture, hold: () => callback?.(), saved: () => saved };
}

test('a short press sends, and a long press saves once without sending on release', () => {
  const f = fixture();
  f.gesture.begin(1, 5, 5);
  f.gesture.end(1);
  f.hold();
  assert.equal(f.saved(), 0);
  assert.equal(f.gesture.allowClick(), true);
  f.gesture.begin(2, 5, 5);
  f.hold();
  f.gesture.end(2);
  assert.equal(f.saved(), 1);
  assert.equal(f.gesture.allowClick(), false);
});

test('movement, cancellation, lost focus and unmount cannot save or send', () => {
  for (const cancel of [(g: ReturnType<typeof createSendPressGesture>) => g.move(1, 40, 40), (g: ReturnType<typeof createSendPressGesture>) => g.cancel()]) {
    const f = fixture();
    f.gesture.begin(1, 5, 5);
    cancel(f.gesture);
    f.hold();
    f.gesture.end(1);
    assert.equal(f.saved(), 0);
    assert.equal(f.gesture.allowClick(), false);
  }
});

test('disabling after a save still suppresses the click; the next tap works', () => {
  const f = fixture();
  f.gesture.begin(1, 5, 5);
  f.hold();
  f.gesture.cancel();
  assert.equal(f.gesture.allowClick(), false);
  f.gesture.begin(2, 5, 5);
  f.gesture.end(2);
  assert.equal(f.gesture.allowClick(), true);
  assert.equal(f.saved(), 1);
});

test('a second pointer cannot replace the first gesture or release it', () => {
  const f = fixture();
  assert.equal(f.gesture.begin(1, 5, 5), true);
  assert.equal(f.gesture.begin(2, 5, 5), false);
  f.gesture.end(2);
  f.hold();
  assert.equal(f.saved(), 1);
  f.gesture.end(1);
  assert.equal(f.gesture.allowClick(), false);
});
