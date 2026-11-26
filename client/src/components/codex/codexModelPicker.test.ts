import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableCodexModelFamilies,
  CODEX_MODEL_FAMILY_LABELS,
  codexModelFamily,
  resolveCodexModelFamily,
} from './codexModelPicker';

const models = [
  { slug: 'gpt-6.2-sol' },
  { slug: 'gemini-4-carbon' },
  { slug: 'deepseek-v4.1-flash-venice' },
  { slug: 'deepseek-v4.1-flash-experiential' },
];

test('Codex picker separates both DeepSeek providers from GPT and Gemini', () => {
  assert.deepEqual(models.map(model => codexModelFamily(model.slug)), ['gpt', 'gemini', 'deepseek', 'deepseek']);
  assert.deepEqual(models.filter(model => codexModelFamily(model.slug) === 'deepseek').map(model => model.slug), [
    'deepseek-v4.1-flash-venice',
    'deepseek-v4.1-flash-experiential',
  ]);
  assert.equal(CODEX_MODEL_FAMILY_LABELS.deepseek, 'DeepSeek');
});

test('only catalog families are offered, in stable order with no duplicates', () => {
  assert.deepEqual(availableCodexModelFamilies([...models].reverse()), ['gpt', 'gemini', 'deepseek']);
  assert.deepEqual(availableCodexModelFamilies(models.slice(2)), ['deepseek']);
  assert.deepEqual(availableCodexModelFamilies([models[0], models[2]]), ['gpt', 'deepseek']);
  assert.deepEqual(availableCodexModelFamilies([models[0]]), ['gpt']);
  assert.deepEqual(availableCodexModelFamilies([]), []);
});

test('registered aliases determine API families, not an arbitrary provider-like prefix', () => {
  assert.equal(codexModelFamily('deepseek-unregistered'), 'gpt');
  assert.equal(codexModelFamily('gemini-unregistered'), 'gpt');
  assert.equal(codexModelFamily(null), 'gpt');
});

test('a selected DeepSeek model opens its own family and manual family browsing still works', () => {
  const families = availableCodexModelFamilies(models);
  assert.equal(resolveCodexModelFamily(families, models[2].slug, null), 'deepseek');
  assert.equal(resolveCodexModelFamily(families, models[3].slug, null), 'deepseek');
  assert.equal(resolveCodexModelFamily(families, models[2].slug, 'gpt'), 'gpt');
  assert.equal(resolveCodexModelFamily(families, models[0].slug, 'deepseek'), 'deepseek');
});

test('changing profile or refreshing the catalog cannot leave an unavailable family selected', () => {
  assert.equal(resolveCodexModelFamily(['gpt'], models[0].slug, 'deepseek'), 'gpt');
  assert.equal(resolveCodexModelFamily(['gemini'], models[2].slug, 'deepseek'), 'gemini');
  assert.equal(resolveCodexModelFamily(['gpt', 'gemini'], models[1].slug, 'deepseek'), 'gemini');
  assert.equal(resolveCodexModelFamily([], null, 'deepseek'), 'gpt');
});
