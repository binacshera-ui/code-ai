import { useEffect, useMemo, useState } from 'react';
import { canAcknowledgeCompletion, hasUnreadCompletion, type SessionCompletion } from './sessionUnread';

export interface SessionReadSnapshot {
  viewed: Record<string, number>;
  completions: Record<string, SessionCompletion>;
}
interface ReadApi {
  read(): Promise<SessionReadSnapshot>;
  mark(sessionId: string, completedAt: number): Promise<{ viewedThrough: number }>;
}
interface SessionSummary {
  id: string;
  lastCompletedAt?: string | null;
}

export function useSessionUnread({ scope, api, sessions, selectedSession, viewport, blocked }: {
  scope: string;
  api: ReadApi;
  sessions: SessionSummary[];
  selectedSession: (SessionSummary & { timeline: Array<{ entryType: string; role?: string; kind?: string; timestamp: string }> }) | null;
  viewport: HTMLElement | null;
  blocked: boolean;
}): Set<string> {
  const [snapshot, setSnapshot] = useState<SessionReadSnapshot & { scope: string }>({ scope, viewed: {}, completions: {} });
  const current = snapshot.scope === scope ? snapshot : null;

  useEffect(() => {
    let disposed = false;
    let reading = false;
    const refresh = async () => {
      if (reading || document.visibilityState !== 'visible') return;
      reading = true;
      try {
        const next = await api.read();
        if (!disposed) setSnapshot(previous => {
          const viewed = { ...next.viewed };
          if (previous.scope === scope) {
            for (const [id, time] of Object.entries(previous.viewed)) viewed[id] = Math.max(time, viewed[id] || 0);
          }
          return { scope, viewed, completions: next.completions };
        });
      } catch {
        // Keep the existing unread state on transient network failures and retry.
      } finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const onVisible = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [api, scope]);

  const completions = useMemo(() => {
    const merged = { ...current?.completions };
    for (const session of [...sessions, ...(selectedSession ? [selectedSession] : [])]) {
      const time = Date.parse(session.lastCompletedAt || '');
      if (Number.isFinite(time) && time > (merged[session.id]?.completedAt || 0)) {
        merged[session.id] = { completedAt: time, startedAt: time };
      }
    }
    return merged;
  }, [current?.completions, sessions, selectedSession]);

  const selectedCompletion = selectedSession ? completions[selectedSession.id] : undefined;
  const selectedViewed = selectedSession ? current?.viewed[selectedSession.id] || 0 : 0;
  const renderedFinalAt = selectedSession ? Math.max(0, ...selectedSession.timeline
    .filter(entry => entry.entryType === 'message' && entry.role === 'assistant' && entry.kind === 'final')
    .map(entry => Date.parse(entry.timestamp) || 0)) : 0;

  useEffect(() => {
    if (!current || !selectedSession || !selectedCompletion || !viewport || !hasUnreadCompletion(selectedCompletion, selectedViewed)) return;
    let disposed = false;
    let pending = false;
    const sessionId = selectedSession.id;
    const completion = selectedCompletion;
    const acknowledge = async () => {
      if (pending || !canAcknowledgeCompletion({
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        blocked: blocked || Boolean(document.querySelector('[role="dialog"][data-state="open"], [aria-modal="true"]')),
        atBottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48,
        renderedFinalAt: Math.max(renderedFinalAt, selectedSession.lastCompletedAt ? Date.parse(selectedSession.lastCompletedAt) : 0),
        completion,
      }) || !renderedFinalAt) return;
      pending = true;
      try {
        const result = await api.mark(sessionId, completion.completedAt);
        if (!disposed) setSnapshot(previous => previous.scope !== scope ? previous : {
          ...previous,
          viewed: { ...previous.viewed, [sessionId]: Math.max(previous.viewed[sessionId] || 0, result.viewedThrough) },
        });
      } catch { pending = false; }
    };
    const timer = window.setInterval(() => void acknowledge(), 1500);
    const onView = () => void acknowledge();
    const initialCheck = window.setTimeout(onView, 500);
    viewport.addEventListener('scroll', onView, { passive: true });
    document.addEventListener('visibilitychange', onView);
    window.addEventListener('focus', onView);
    return () => {
      disposed = true;
      window.clearTimeout(initialCheck);
      window.clearInterval(timer);
      viewport.removeEventListener('scroll', onView);
      document.removeEventListener('visibilitychange', onView);
      window.removeEventListener('focus', onView);
    };
  }, [api, scope, current !== null, selectedSession?.id, selectedSession?.lastCompletedAt, selectedCompletion?.completedAt, selectedCompletion?.startedAt, selectedViewed, viewport, blocked, renderedFinalAt]);

  return useMemo(() => new Set(Object.keys(completions).filter(id => (
    current && hasUnreadCompletion(completions[id], current.viewed[id])
  ))), [completions, current?.viewed]);
}
