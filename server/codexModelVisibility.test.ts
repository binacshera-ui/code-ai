import assert from 'node:assert/strict';
import test from 'node:test';
import { isUserSelectableCodexModel } from './codexModelVisibility.js';

test('keeps the entitled GPT-Reserve fallback selectable even when Codex marks it hidden', () => {
  assert.equal(isUserSelectableCodexModel({ slug: 'gpt-reserve', visibility: 'hide' }), true);
  assert.equal(isUserSelectableCodexModel({ slug: 'GPT-RESERVE', visibility: 'hidden' }), true);
});

test('does not expose other hidden internal Codex models', () => {
  assert.equal(isUserSelectableCodexModel({ slug: 'codex-auto-review', visibility: 'hide' }), false);
  assert.equal(isUserSelectableCodexModel({ slug: 'gpt-reserve', visibility: 'list' }), true);
  assert.equal(isUserSelectableCodexModel({ slug: 'gpt-5.6-luna', visibility: 'list' }), true);
});
