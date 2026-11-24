import assert from 'node:assert/strict';
import test from 'node:test';
import { codexResponseSpeedModes, normalizeCodexServiceTierConfigValue, normalizeCodexServiceTierValue, selectedCodexResponseSpeed } from './codexResponseSpeed.js';

test('all three speed modes retain the actual native config values', () => {
  assert.equal(normalizeCodexServiceTierValue('priority'), 'fast');
  assert.equal(normalizeCodexServiceTierValue('standard'), 'flex');
  assert.equal(normalizeCodexServiceTierValue('ULTRAFAST'), 'ultrafast');
  assert.equal(normalizeCodexServiceTierConfigValue('ultrafast'), 'ultrafast');
  assert.equal(normalizeCodexServiceTierConfigValue('flex'), null);
  assert.equal(normalizeCodexServiceTierValue('invented'), null);
});
test('unentitled models omit Ultrafast entirely, not a disabled option', () => {
  assert.deepEqual(codexResponseSpeedModes(['flex', 'fast']).map(m => m.id), ['flex', 'fast']);
  assert.deepEqual(codexResponseSpeedModes(['flex']).map(m => m.id), ['flex']);
  assert.deepEqual(codexResponseSpeedModes(['flex', 'fast', 'ultrafast']).map(m => m.id), ['flex', 'fast', 'ultrafast']);
  assert.equal(selectedCodexResponseSpeed(['flex', 'fast'], 'ultrafast'), 'flex');
  assert.equal(selectedCodexResponseSpeed(['flex', 'fast', 'ultrafast'], 'ultrafast'), 'ultrafast');
});
