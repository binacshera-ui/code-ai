import { useEffect, useState } from 'react';
import { modelRetryMessage, type ModelRetryNoticeState } from './modelRetryPresentation';

export function ModelRetryNotice({ notice }: { notice: ModelRetryNoticeState }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [notice.itemId, notice.retryAt]);
  return <div dir="rtl" role="status" aria-live="off" data-testid="model-retry-notice"
    className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
    <div className="font-semibold">{modelRetryMessage(notice, now)}</div>
    <div className="text-xs">{notice.attempt ? `ניסיון המשך ${notice.attempt} · ` : ''}אותה שיחה ואותו מודל. ההיסטוריה נשמרת; עצירה או הודעה חדשה מבטלות את ההמשך האוטומטי.</div>
  </div>;
}
