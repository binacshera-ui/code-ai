/** Read-only transport boundary shared by supervised model processes. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isGeminiCodexModel } from '../shared/codexGeminiModels.mjs';

export const subscriptionAccountKey = accountId => createHash('sha256')
  .update('codex\0' + accountId.trim()).digest('hex');

export async function subscriptionTransportBlocked(stateFile, accountId, model, now = Date.now()) {
  if (!stateFile || !accountId || isGeminiCodexModel(model)) return false;
  try {
    const bytes = await readFile(stateFile);
    if (bytes.length > 2 * 1024 * 1024) return true;
    const state = JSON.parse(bytes.toString('utf8'));
    if (state.format !== 'code-ai-subscription-quota-stop' || state.version !== 1 || !state.accounts) return true;
    const entry = state.accounts[subscriptionAccountKey(accountId)];
    if (!entry) return false;
    if (entry.settings?.enabled === false) return false;
    const observed = Date.parse(entry.snapshot?.observedAt || '');
    return entry.settings?.enabled !== true || entry.latch != null
      || entry.snapshot?.state !== 'armed' || !Number.isFinite(observed)
      || now < observed || now - observed > 30_000;
  } catch (error) {
    // A missing file means this installation has never enabled the feature.
    // A configured but corrupt/unreadable policy is not permission to spend.
    return error.code !== 'ENOENT';
  }
}
