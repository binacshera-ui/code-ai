import type { CodexExecutionConfig, CodexModelCatalog } from './codexService.js';

const normalize = (value: string | null | undefined) => value?.trim() || null;

// Isolated CLI runs may inherit defaults. Shared-owner queue reservations must
// materialize them before admission, including historical retry/continue items.
export async function resolveCodexExecutionSelection(
  executionConfig: CodexExecutionConfig | null | undefined,
  loadCatalog: () => Promise<CodexModelCatalog>,
  materializeDefaults = false,
): Promise<CodexExecutionConfig> {
  const requestedModel = normalize(executionConfig?.model);
  const requestedReasoningEffort = normalize(executionConfig?.reasoningEffort);
  const requestedPermissionModeId = normalize(executionConfig?.permissionModeId);

  if (!materializeDefaults && !requestedModel && !requestedReasoningEffort) {
    return {
      model: null,
      reasoningEffort: null,
      permissionModeId: requestedPermissionModeId,
    };
  }

  const catalog = await loadCatalog();
  const fallbackModel = requestedModel
    || catalog.selectedModel
    || catalog.models[0]?.slug
    || null;
  const selectedModelOption = fallbackModel
    ? catalog.models.find((model) => model.slug === fallbackModel) || null
    : null;

  if (requestedModel && !selectedModelOption) {
    throw new Error(`Codex model "${requestedModel}" is not available for this profile`);
  }

  if (
    requestedReasoningEffort
    && selectedModelOption
    && !selectedModelOption.supportedReasoningLevels.some((level) => level.effort === requestedReasoningEffort)
  ) {
    throw new Error(`Reasoning effort "${requestedReasoningEffort}" is not supported by ${selectedModelOption.displayName}`);
  }

  return {
    model: selectedModelOption?.slug || requestedModel || null,
    reasoningEffort: requestedReasoningEffort || (materializeDefaults
      ? (fallbackModel === catalog.selectedModel ? catalog.selectedReasoningEffort : selectedModelOption?.defaultReasoningLevel) || null
      : null),
    permissionModeId: requestedPermissionModeId,
  };
}

