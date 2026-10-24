export const DRAFT_PRESS_DELAY_MS = 600;

/** A long press consumes the eventual click, even if saving disables the button. */
export function createSendPressGesture(onDraft: () => void, timers = {
  set: (callback: () => void, delay: number) => setTimeout(callback, delay),
  clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pointer: { id: number; x: number; y: number } | null = null;
  let suppressClick = false;
  const clearTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  return {
    begin(id: number, x: number, y: number) {
      if (pointer) return false;
      suppressClick = false;
      pointer = { id, x, y };
      timer = timers.set(() => {
        timer = null;
        suppressClick = true;
        onDraft();
      }, DRAFT_PRESS_DELAY_MS);
      return true;
    },
    move(id: number, x: number, y: number) {
      if (pointer?.id === id && Math.hypot(x - pointer.x, y - pointer.y) > 10) {
        clearTimer();
        suppressClick = true;
      }
    },
    end(id: number) {
      if (pointer?.id !== id) return;
      clearTimer();
      pointer = null;
    },
    cancel() {
      clearTimer();
      if (pointer) suppressClick = true;
      pointer = null;
    },
    allowClick() {
      const allowed = !suppressClick;
      suppressClick = false;
      return allowed;
    },
  };
}
