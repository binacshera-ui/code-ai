export interface SessionCompletion {
  completedAt: number;
  startedAt: number;
}

export function hasUnreadCompletion(completion: SessionCompletion | undefined, viewedThrough = 0): boolean {
  return Boolean(completion && completion.completedAt > viewedThrough);
}

export function canAcknowledgeCompletion(input: {
  visible: boolean;
  focused: boolean;
  blocked: boolean;
  atBottom: boolean;
  renderedFinalAt: number;
  completion: SessionCompletion;
}): boolean {
  return input.visible && input.focused && !input.blocked && input.atBottom
    && input.renderedFinalAt >= input.completion.startedAt;
}
