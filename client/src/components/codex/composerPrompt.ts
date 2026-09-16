export function appendComposerPrompt(currentPrompt: string, appendedPrompt: string): string {
  const addition = appendedPrompt.trim();
  if (!addition) return currentPrompt;
  if (!currentPrompt.trim()) return addition;
  if (currentPrompt.endsWith('\n\n')) return `${currentPrompt}${addition}`;
  if (currentPrompt.endsWith('\n')) return `${currentPrompt}\n${addition}`;
  return `${currentPrompt}\n\n${addition}`;
}
