import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexUserInputAnswerResult, CodexUserInputRequest, CodexUserInputResponse, CodexUserInputSnapshot } from '../../../../shared/codexUserInput';

export interface CodexUserInputApi {
  read: (signal: AbortSignal) => Promise<CodexUserInputSnapshot>;
  answer: (id: string, response: CodexUserInputResponse) => Promise<CodexUserInputAnswerResult>;
}

/** This control plane deliberately has no access to the composer or prompt queue. */
export function useCodexUserInput(scope: string, api: CodexUserInputApi | null, busy: boolean) {
  const [state, setState] = useState<{ scope: string; requests: CodexUserInputRequest[] }>({ scope, requests: [] });
  const [error, setError] = useState<{ scope: string; id: string; message: string } | null>(null);
  const [submitting, setSubmitting] = useState<{ scope: string; id: string } | null>(null);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const submitLocks = useRef(new Set<string>());
  const refreshVersion = useRef(0);
  const requests = state.scope === scope ? state.requests : [];

  useEffect(() => {
    if (!api) return;
    let stopped = false;
    let inFlight = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      const version = refreshVersion.current;
      try {
        if (document.visibilityState !== 'hidden') {
          const snapshot = await api.read(controller.signal);
          if (!stopped && activeScope.current === scope && version === refreshVersion.current) {
            setState({ scope, requests: snapshot.requests });
          }
        }
      } catch {
        // A legacy remote node can lack this route. Keep an existing question
        // visible on transient disconnects; never invent an answer or a new run.
      } finally {
        inFlight = false;
        if (!stopped) timeout = setTimeout(poll, busy ? 1_200 : 5_000);
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') {
        if (timeout) clearTimeout(timeout);
        void poll();
      }
    };
    void poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      controller.abort();
      if (timeout) clearTimeout(timeout);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [api, busy, scope]);

  const answer = useCallback(async (id: string, response: CodexUserInputResponse) => {
    if (!api) throw new Error('השיחה אינה זמינה למענה כרגע.');
    const key = JSON.stringify([scope, id]);
    if (submitLocks.current.has(key)) return;
    submitLocks.current.add(key);
    setSubmitting({ scope, id });
    setError(null);
    try {
      const result = await api.answer(id, response);
      refreshVersion.current += 1;
      if (activeScope.current === scope) {
        setState(current => ({
          scope,
          requests: (current.scope === scope ? current.requests : []).map(request => request.id === id ? result.request : request),
        }));
      }
    } catch (failure) {
      if (activeScope.current === scope) {
        setError({ scope, id, message: failure instanceof Error ? failure.message : 'לא הצלחנו להעביר את התשובה. אפשר לנסות שוב.' });
      }
      throw failure;
    } finally {
      submitLocks.current.delete(key);
      if (activeScope.current === scope) setSubmitting(null);
    }
  }, [api, scope]);
  return {
    requests,
    answer,
    submittingId: submitting?.scope === scope ? submitting.id : null,
    error: error?.scope === scope ? error : null,
  };
}
