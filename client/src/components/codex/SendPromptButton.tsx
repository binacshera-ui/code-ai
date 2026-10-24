import { useEffect, useRef } from 'react';
import { Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createSendPressGesture } from './sendPressGesture';

export function SendPromptButton({ disabled, onSend, onSaveDraft }: {
  disabled: boolean;
  onSend: () => void;
  onSaveDraft: () => void;
}) {
  const callbacks = useRef({ disabled, onSaveDraft });
  callbacks.current = { disabled, onSaveDraft };
  const gesture = useRef<ReturnType<typeof createSendPressGesture> | null>(null);
  if (!gesture.current) {
    gesture.current = createSendPressGesture(() => {
      if (!callbacks.current.disabled) callbacks.current.onSaveDraft();
    });
  }
  const press = gesture.current;
  useEffect(() => {
    if (disabled) press.cancel();
  }, [disabled, press]);
  useEffect(() => {
    const cancel = () => press.cancel();
    const onVisibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancel();
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [press]);

  return <button
    type="button"
    aria-label="שלח הודעה"
    title="לחיצה לשליחה · לחיצה ארוכה לשמירת טיוטה · Shift+Enter לשמירת טיוטה"
    disabled={disabled}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0 || disabled) return;
      if (press.begin(event.pointerId, event.clientX, event.clientY)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }}
    onPointerMove={(event) => press.move(event.pointerId, event.clientX, event.clientY)}
    onPointerUp={(event) => press.end(event.pointerId)}
    onPointerCancel={() => press.cancel()}
    onLostPointerCapture={() => press.cancel()}
    onBlur={() => press.cancel()}
    onContextMenu={(event) => event.preventDefault()}
    onClick={(event) => {
      if (!press.allowClick()) {
        event.preventDefault();
        return;
      }
      onSend();
    }}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        press.cancel();
        press.allowClick();
      }
      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        if (!event.repeat && !disabled) onSaveDraft();
      }
    }}
    className={cn(
      'mb-[3px] ml-[3px] shrink-0 touch-none select-none rounded-full border border-white/80 bg-gradient-to-br from-rose-200 via-amber-100 to-sky-200 p-[0.56rem] text-slate-700 shadow-[0_12px_26px_-16px_rgba(99,102,241,0.5)] transition-all active:scale-95',
      'hover:from-rose-200 hover:via-amber-100 hover:to-sky-200 hover:text-slate-800',
      'disabled:border-slate-100 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none disabled:opacity-35'
    )}
  >
    <Send className="h-4 w-4 -ml-0.5" />
  </button>;
}
