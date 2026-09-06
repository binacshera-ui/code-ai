import { useEffect, useMemo, useState } from 'react';
import { activeTaskLabel, selectRunningTasks, type ActiveTaskItem } from './activeTasks';

export function ActiveTaskChips<T extends ActiveTaskItem>({ scope, profileId, loadItems, sessions, selectedSessionId, onSelect }: {
  scope: string;
  profileId: string;
  loadItems: (signal: AbortSignal) => Promise<T[]>;
  sessions: Array<{ id: string; title: string }>;
  selectedSessionId: string | null;
  onSelect: (item: T) => void;
}) {
  const [snapshot, setSnapshot] = useState<{ scope: string; items: T[]; failed: boolean }>({ scope, items: [], failed: false });
  const titles = useMemo(() => new Map(sessions.map(session => [session.id, session.title])), [sessions]);

  // This small read-only feed stays live while transcript/sidebar polling pauses.
  // Keeping it local avoids refreshing or moving the transcript under the user.
  useEffect(() => {
    let disposed = false;
    let request: AbortController | null = null;
    const refresh = async () => {
      if (request) return;
      const controller = new AbortController();
      request = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const items = await loadItems(controller.signal);
        if (!disposed) setSnapshot({ scope, items: selectRunningTasks(items, profileId), failed: false });
      } catch {
        // Do not label a stale or stopped task as currently running after a failure.
        if (!disposed) setSnapshot({ scope, items: [], failed: true });
      } finally {
        window.clearTimeout(timeout);
        request = null;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const timer = window.setInterval(onVisible, 5000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      request?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [scope, profileId, loadItems]);

  if (snapshot.scope !== scope) return null;
  if (snapshot.failed) return <p className="mt-2 text-[10px] text-slate-400" role="status">עדכון הפעילות אינו זמין כרגע</p>;
  if (!snapshot.items.length) return null;

  return (
    <section aria-label="משימות פעילות עכשיו" className="mt-2 min-w-0" dir="rtl">
      <div className="mb-1 text-[10px] font-medium text-slate-400">עכשיו · {snapshot.items.length}</div>
      <div className="flex max-h-[4.5rem] flex-wrap gap-1 overflow-y-auto">
        {snapshot.items.map(item => {
          const label = activeTaskLabel(item, titles);
          const stopping = item.status === 'cancelling';
          const selected = selectedSessionId === (item.sessionId || item.queueKey);
          return (
            <button
              key={item.id}
              type="button"
              data-active-task-id={item.id}
              aria-label={`${stopping ? 'בעצירה' : 'פעילה'}: ${label}`}
              aria-current={selected ? 'page' : undefined}
              title={`${stopping ? 'בעצירה' : 'פעילה'}: ${label}`}
              onClick={() => onSelect(item)}
              className={`inline-flex h-6 max-w-[10.5rem] items-center gap-1.5 rounded-full border px-2 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${stopping ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'}`}
            >
              <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${stopping ? 'bg-amber-500' : 'bg-emerald-500 motion-safe:animate-pulse'}`} />
              <span className="min-w-0 truncate">{label}</span>
              {stopping && <span className="shrink-0">· עוצר</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
