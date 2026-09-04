import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUsagePanelPlacement } from './usagePanelPosition.js';

test('keeps the usage panel inside the viewport when its trigger is at the left edge', () => {
  const placement = resolveUsagePanelPlacement(
    { left: 66, right: 102, top: 1170, bottom: 1206, width: 36 },
    { width: 2560, height: 1305, offsetLeft: 0, offsetTop: 0, layoutHeight: 1305 }
  );

  assert.equal(placement.left, 12);
  assert.equal(placement.width, 368);
  assert.ok(placement.left + placement.width <= 2560 - 12);
  assert.equal(placement.opensAbove, true);
});
test('fits the panel to a narrow embedded or mobile viewport', () => {
  const placement = resolveUsagePanelPlacement(
    { left: 10, right: 46, top: 700, bottom: 736, width: 36 },
    { width: 280, height: 780, offsetLeft: 0, offsetTop: 0, layoutHeight: 780 }
  );

  assert.equal(placement.left, 12);
  assert.equal(placement.width, 256);
  assert.equal(placement.left + placement.width, 268);
  assert.ok(placement.maxHeight <= 608);
});

test('clamps a right-edge trigger and opens below when more room is available there', () => {
  const placement = resolveUsagePanelPlacement(
    { left: 340, right: 376, top: 40, bottom: 76, width: 36 },
    { width: 390, height: 844, offsetLeft: 0, offsetTop: 0, layoutHeight: 844 }
  );

  assert.equal(placement.left, 12);
  assert.equal(placement.width, 366);
  assert.equal(placement.opensAbove, false);
  assert.equal(placement.top, 84);
  assert.equal(placement.bottom, null);
});
