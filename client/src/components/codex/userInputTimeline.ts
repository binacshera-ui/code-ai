import type { CodexUserInputRequest } from '../../../../shared/codexUserInput';

/** Position question receipts in the conversation, not below future answers. */
export function interleaveUserInput<T>(blocks: T[], requests: CodexUserInputRequest[], timestamp: (block: T) => string): Array<T | { type: 'user-input'; request: CodexUserInputRequest }> {
  const sorted = [...requests].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const result: Array<T | { type: 'user-input'; request: CodexUserInputRequest }> = [];
  let index = 0;
  for (const block of blocks) {
    const at = Date.parse(timestamp(block));
    while (index < sorted.length && Date.parse(sorted[index].createdAt) <= at) {
      result.push({ type: 'user-input', request: sorted[index++] });
    }
    result.push(block);
  }
  while (index < sorted.length) result.push({ type: 'user-input', request: sorted[index++] });
  return result;
}
