import { useEffect, useRef, useState } from 'react';
import {
  Check,
  FileText,
  Loader2,
  MessageSquareShare,
  Search,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ConversationShareSession {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string | null;
  messageCount: number;
  preview: string;
  hidden?: boolean;
  isDraft?: boolean;
}

export interface ConversationShareCandidatesPage {
  sessions: ConversationShareSession[];
  hasMore: boolean;
  nextOffset: number | null;
}

export function ConversationShareDialog({
  isOpen,
  currentSessionId,
  maxSelection,
  isExporting,
  error,
  loadCandidates,
  onClose,
  onAttach,
}: {
  isOpen: boolean;
  currentSessionId: string | null;
  maxSelection: number;
  isExporting: boolean;
  error: string | null;
  loadCandidates: (query: string, offset: number) => Promise<ConversationShareCandidatesPage>;
  onClose: () => void;
  onAttach: (sessionIds: string[]) => Promise<void> | void;
}) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [availableSessions, setAvailableSessions] = useState<ConversationShareSession[]>([]);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const requestIdRef = useRef(0);
  const loadCandidatesRef = useRef(loadCandidates);
  loadCandidatesRef.current = loadCandidates;

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIds(new Set());
      setAvailableSessions([]);
      setIsLoadingCandidates(false);
      setCandidatesError(null);
      setHasMore(false);
      setNextOffset(null);
      return;
    }
    requestIdRef.current += 1;
    setIsLoadingCandidates(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const timer = window.setTimeout(() => {
      setIsLoadingCandidates(true);
      setCandidatesError(null);
      void loadCandidatesRef.current(query.trim(), 0)
        .then((page) => {
          if (requestId !== requestIdRef.current) return;
          setAvailableSessions(page.sessions);
          setHasMore(page.hasMore);
          setNextOffset(page.nextOffset);
        })
        .catch((loadError: any) => {
          if (requestId !== requestIdRef.current) return;
          setAvailableSessions([]);
          setHasMore(false);
          setNextOffset(null);
          setCandidatesError(loadError?.message || 'טעינת השיחות נכשלה.');
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setIsLoadingCandidates(false);
          }
        });
    }, query.trim() ? 250 : 0);

    return () => window.clearTimeout(timer);
  }, [isOpen, query]);

  const loadMoreCandidates = async () => {
    if (isLoadingCandidates || !hasMore || nextOffset === null) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsLoadingCandidates(true);
    setCandidatesError(null);
    try {
      const page = await loadCandidatesRef.current(query.trim(), nextOffset);
      if (requestId !== requestIdRef.current) return;
      setAvailableSessions((current) => {
        const merged = new Map(current.map((session) => [session.id, session]));
        page.sessions.forEach((session) => merged.set(session.id, session));
        return [...merged.values()];
      });
      setHasMore(page.hasMore);
      setNextOffset(page.nextOffset);
    } catch (loadError: any) {
      if (requestId !== requestIdRef.current) return;
      setCandidatesError(loadError?.message || 'טעינת שיחות נוספות נכשלה.');
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoadingCandidates(false);
      }
    }
  };

  if (!isOpen) return null;

  const selectableVisibleIds = availableSessions
    .filter((session) => session.id !== currentSessionId)
    .map((session) => session.id);
  const allVisibleSelected = selectableVisibleIds.length > 0
    && selectableVisibleIds.every((sessionId) => selectedIds.has(sessionId));

  const toggleSession = (sessionId: string) => {
    if (sessionId === currentSessionId || isExporting) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else if (next.size < maxSelection) {
        next.add(sessionId);
      }
      return next;
    });
  };

  const toggleAllVisible = () => {
    if (isExporting) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        selectableVisibleIds.forEach((sessionId) => next.delete(sessionId));
        return next;
      }
      for (const sessionId of selectableVisibleIds) {
        if (next.size >= maxSelection) break;
        next.add(sessionId);
      }
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-[79] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center"
      data-testid="conversation-share-dialog"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={isExporting ? undefined : onClose}
        aria-label="סגור שיתוף שיחות"
      />
      <div className="relative z-10 flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.38)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
              <MessageSquareShare className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Conversation Context
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-800">שיתוף שיחה אחרת</div>
              <div className="mt-1 text-xs leading-6 text-slate-500">
                כל שיחה מסומנת תיוצא לקובץ Markdown מלא של שאלות המשתמש והתשובות הסופיות, ותצורף כקובץ רגיל להודעה הבאה.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
            aria-label="סגור"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-slate-100 px-5 py-4">
          <div className="relative">
            <Search className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="חפש לפי שם, תוכן או תיקייה"
              className="h-11 w-full rounded-[1.1rem] border border-slate-200 bg-slate-50/70 pr-11 pl-4 text-sm text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white"
              data-testid="conversation-share-search"
              autoFocus
            />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs">
            <button
              type="button"
              onClick={toggleAllVisible}
              disabled={selectableVisibleIds.length === 0 || isExporting}
              className="font-medium text-indigo-600 transition hover:text-indigo-700 disabled:opacity-40"
            >
              {allVisibleSelected ? 'בטל בחירה בתוצאות' : 'בחר את כל התוצאות'}
            </button>
            <div className="text-slate-400">
              נבחרו <span className="font-semibold text-slate-700">{selectedIds.size}</span> מתוך {maxSelection}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {isLoadingCandidates && availableSessions.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-[1.5rem] border border-slate-100 bg-slate-50/60 px-5 text-center">
              <Loader2 className="h-7 w-7 animate-spin text-indigo-400" />
              <div className="mt-3 text-sm font-semibold text-slate-600">טוען את כל השיחות</div>
              <div className="mt-1 text-xs text-slate-400">התוצאות מגיעות בעמודים כדי לשמור על ממשק מהיר.</div>
            </div>
          ) : availableSessions.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50/60 px-5 text-center">
              <MessageSquareShare className="h-7 w-7 text-slate-300" />
              <div className="mt-3 text-sm font-semibold text-slate-600">לא נמצאו שיחות</div>
              <div className="mt-1 text-xs text-slate-400">נסה חיפוש אחר או רענן את רשימת השיחות.</div>
            </div>
          ) : (
            <div className="space-y-2.5">
              {availableSessions.map((session) => {
                const selected = selectedIds.has(session.id);
                const isCurrent = session.id === currentSessionId;
                return (
                  <button
                    key={session.id}
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    disabled={isCurrent || isExporting}
                    onClick={() => toggleSession(session.id)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-[1.25rem] border px-4 py-3.5 text-right transition',
                      selected
                        ? 'border-indigo-200 bg-indigo-50/70 shadow-sm'
                        : 'border-slate-100 bg-white hover:border-indigo-100 hover:bg-indigo-50/30',
                      isCurrent && 'cursor-not-allowed bg-slate-50/70 opacity-60',
                    )}
                    data-testid={`conversation-share-session-${session.id}`}
                  >
                    <span className={cn(
                      'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition',
                      selected ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-200 bg-white text-transparent',
                    )}>
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-semibold text-slate-800">{session.title || 'שיחה ללא כותרת'}</span>
                        {isCurrent && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-600">השיחה הנוכחית</span>}
                        {session.hidden && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">ארכיון</span>}
                        {session.isDraft && <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] text-sky-700">טיוטה</span>}
                      </span>
                      <span className="mt-1 block line-clamp-2 text-xs leading-5 text-slate-500">{session.preview || 'אין תצוגה מקדימה'}</span>
                      <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400">
                        <span>{session.messageCount} הודעות</span>
                        <span>{new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(session.updatedAt))}</span>
                        {session.cwd && <span className="max-w-full truncate" dir="ltr">{session.cwd}</span>}
                      </span>
                    </span>
                    <FileText className="mt-1 h-4 w-4 shrink-0 text-slate-300" />
                  </button>
                );
              })}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void loadMoreCandidates()}
                  disabled={isLoadingCandidates}
                  className="flex w-full items-center justify-center gap-2 rounded-[1.1rem] border border-dashed border-indigo-200 bg-indigo-50/40 px-4 py-3 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-50"
                  data-testid="conversation-share-load-more"
                >
                  {isLoadingCandidates && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  טען שיחות נוספות
                </button>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-slate-100 px-5 py-4">
          {(error || candidatesError) && (
            <div className="mb-3 rounded-[1rem] border border-red-100 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700" role="alert">
              {error || candidatesError}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isExporting}
              className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            >
              ביטול
            </button>
            <button
              type="button"
              onClick={() => void onAttach([...selectedIds])}
              disabled={selectedIds.size === 0 || isExporting}
              className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="conversation-share-attach"
            >
              {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquareShare className="h-4 w-4" />}
              {isExporting ? 'מייצא שיחות...' : `צרף ${selectedIds.size || ''} כשקבצי Markdown`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
