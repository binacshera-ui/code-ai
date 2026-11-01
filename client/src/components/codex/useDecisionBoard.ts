import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createDecisionBoardClientCache, type DecisionBoardApi, type DecisionBoardClientState } from './decisionBoardClient';

const EMPTY: DecisionBoardClientState = { board: null, drafts: {}, loading: false, saving: false, submitting: false, error: null, uncertain: false, receipt: null };
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

/** Independent small control-plane reads; never await the conversation poll.
 * Keep controllers per scope so closing or switching chats does not lose drafts. */
export function useDecisionBoard(scope: string, api: DecisionBoardApi | null, open: boolean, createRequestId: () => string, nativePending = false) {
  const cache = useRef(createDecisionBoardClientCache()).current;
  const current = api ? cache.get(scope, api, createRequestId) : null;
  const state = useSyncExternalStore(current?.subscribe || noopSubscribe, current?.getSnapshot || emptySnapshot, current?.getSnapshot || emptySnapshot);
  const tracking = open || Boolean(state.board?.enabled) || nativePending;
  useEffect(() => {
    if (!current) return;
    const refresh = () => { if (document.visibilityState !== 'hidden') void current.refresh(); };
    // Load the small initial snapshot even in a background tab. Otherwise an
    // initially hidden conversation has neither a badge nor an enabled-mode
    // state and may never subscribe to visibility changes until opened.
    void current.refresh();
    if (!tracking) return;
    const timer = setInterval(refresh, open ? 5_000 : 20_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [current, open, tracking]);
  return { client: current, state };
}
