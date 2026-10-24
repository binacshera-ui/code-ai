import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCodexExecutionSelection } from './codexExecutionSelection.js';
import type { CodexModelCatalog } from './codexService.js';

const catalog = {
  selectedModel: 'profile-model', selectedReasoningEffort: 'high',
  models: [
    { slug: 'profile-model', displayName: 'Profile model', defaultReasoningLevel: 'medium',
      supportedReasoningLevels: [{ effort: 'medium' }, { effort: 'high' }] },
    { slug: 'other-model', displayName: 'Other model', defaultReasoningLevel: 'low',
      supportedReasoningLevels: [{ effort: 'low' }, { effort: 'medium' }] },
  ],
} as CodexModelCatalog;
const load = async () => catalog;

test('shared historical continuation and retry resolve omitted settings from profile', async () => {
  for (const config of [undefined, null, { model: null, reasoningEffort: null, permissionModeId: null }]) {
    assert.deepEqual(await resolveCodexExecutionSelection(config, load, true), {
      model: 'profile-model', reasoningEffort: 'high', permissionModeId: null,
    });
  }
});
test('isolated default requests keep native inheritance without fetching catalog', async () => {
  assert.deepEqual(await resolveCodexExecutionSelection(undefined, async () => { throw Error('unexpected load'); }), {
    model: null, reasoningEffort: null, permissionModeId: null,
  });
});
test('shared explicit choices and permissions remain intact', async () => {
  assert.deepEqual(await resolveCodexExecutionSelection({ model: ' other-model ', reasoningEffort: 'medium', permissionModeId: 'restricted' }, load, true), {
    model: 'other-model', reasoningEffort: 'medium', permissionModeId: 'restricted',
  });
});
test('an explicitly different model uses its own effort default', async () => {
  assert.equal((await resolveCodexExecutionSelection({ model: 'other-model' }, load, true)).reasoningEffort, 'low');
});
test('effort-only requests resolve the selected profile model', async () => {
  assert.equal((await resolveCodexExecutionSelection({ reasoningEffort: 'medium' }, load, true)).model, 'profile-model');
});
test('invalid explicit model and effort still fail before submission', async () => {
  await assert.rejects(resolveCodexExecutionSelection({ model: 'missing' }, load, true), /not available/);
  await assert.rejects(resolveCodexExecutionSelection({ model: 'other-model', reasoningEffort: 'high' }, load, true), /not supported/);
});
test('empty catalogs do not invent a model or bypass admission', async () => {
  const result = await resolveCodexExecutionSelection(null, async () => ({ ...catalog, selectedModel: null, selectedReasoningEffort: null, models: [] }), true);
  assert.equal(result.model, null);
});
