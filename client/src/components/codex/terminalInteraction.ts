/** Terminal cells keep their coordinates; the reader renders logical text with browser bidi. */
export function terminalScrollLines(delta: number, mode: number, rows: number, lineHeight: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const lines = mode === 2 ? delta * rows : mode === 1 ? delta : delta / Math.max(1, lineHeight);
  return Math.sign(lines) * Math.max(1, Math.round(Math.abs(lines)));
}

export function terminalHistoryKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): 'pageUp' | 'pageDown' | 'top' | 'bottom' | null {
  if (!event.shiftKey || event.altKey || event.metaKey) return null;
  if (event.key === 'PageUp') return 'pageUp';
  if (event.key === 'PageDown') return 'pageDown';
  if (event.ctrlKey && event.key === 'Home') return 'top';
  if (event.ctrlKey && event.key === 'End') return 'bottom';
  return null;
}

export interface ReadableTerminalBuffer {
  length: number;
  getLine(index: number): {isWrapped: boolean; translateToString(trimRight?: boolean): string} | undefined;
}

export function terminalReadableText(buffer: ReadableTerminalBuffer, maxLines = 5000): string {
  let text = '';
  for (let i = Math.max(0, buffer.length - maxLines); i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const nextWrapped = buffer.getLine(i + 1)?.isWrapped === true;
    text += (text && !line.isWrapped ? '\n' : '') + line.translateToString(!nextWrapped);
  }
  return text.replace(/\n+$/, '');
}
