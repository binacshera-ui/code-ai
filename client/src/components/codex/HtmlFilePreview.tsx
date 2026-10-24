import { useEffect, useState } from 'react';
import { CodexCodeBlock } from './CodexCodeBlock';
import { buildHtmlFilePreviewUrl } from './markdownFiles';
import { prepareHtmlPreviewDocument, type HtmlPreviewFetch } from './htmlPreviewDocument';

/** Local HTML runs in an opaque-origin sandbox, never with the app's authority. */
export function HtmlFilePreview({
  contentUrl,
  content,
  name,
  serverId,
  fetchFile,
  truncated = false,
}: {
  contentUrl: string;
  content: string | null;
  name: string;
  serverId: string;
  fetchFile: HtmlPreviewFetch;
  truncated?: boolean;
}) {
  const [showSource, setShowSource] = useState(false);
  const [reload, setReload] = useState(0);
  const previewUrl = buildHtmlFilePreviewUrl(contentUrl, serverId);
  const preparationKey = `${previewUrl}:${reload}`;
  const [prepared, setPrepared] = useState<{
    key: string;
    phase: 'loading' | 'ready' | 'error';
    srcDoc?: string;
    warnings?: string[];
    error?: string;
  }>({ key: '', phase: 'loading' });
  const current = prepared.key === preparationKey ? prepared : { key: preparationKey, phase: 'loading' as const };

  useEffect(() => {
    if (!previewUrl) return;
    const controller = new AbortController();
    setPrepared({ key: preparationKey, phase: 'loading' });
    void prepareHtmlPreviewDocument({
      assetUrl: previewUrl,
      origin: window.location.origin,
      signal: controller.signal,
      fetchFile,
    }).then((result) => {
      if (!controller.signal.aborted) setPrepared({ key: preparationKey, phase: 'ready', ...result });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setPrepared({
        key: preparationKey,
        phase: 'error',
        error: error instanceof Error ? error.message : 'Preview preparation failed',
      });
    });
    return () => controller.abort();
  }, [fetchFile, preparationKey, previewUrl]);
  return (
    <div className="space-y-3" dir="rtl">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={!showSource} onClick={() => setShowSource(false)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700">
          תצוגה אינטראקטיבית
        </button>
        <button type="button" aria-pressed={showSource} onClick={() => setShowSource(true)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700">
          קוד מקור
        </button>
        {!showSource && previewUrl && (
          <button type="button" onClick={() => setReload((value) => value + 1)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
            טען מחדש
          </button>
        )}
      </div>
      {showSource ? (
        <>
          {truncated && <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">מוצג קוד מקור חלקי. אפשר להוריד את הקובץ המלא מהכפתור למעלה.</div>}
          <CodexCodeBlock code={content || ''} language="html" />
        </>
      ) : previewUrl ? (
        <>
          <div className="text-xs text-slate-500">תצוגה מבודדת: קוד הדף יכול לפעול, ללא גישה לחשבון או לנתוני היישום.</div>
          {current.phase === 'loading' ? (
            <div role="status" className="flex min-h-[240px] items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">טוען קבצים ומכין תצוגה מבודדת...</div>
          ) : current.phase === 'error' ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">לא ניתן להכין את התצוגה. אפשר לנסות שוב או לצפות בקוד המקור. <span dir="auto">{current.error}</span></div>
          ) : (
            <>
              {Boolean(current.warnings?.length) && (
                <div role="status" className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {current.warnings?.map((warning) => <div key={warning}>{warning}</div>)}
                </div>
              )}
              <iframe
                key={preparationKey}
                srcDoc={current.srcDoc}
                title={`תצוגה מקדימה: ${name}`}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="h-[68dvh] w-full rounded-[1.5rem] border border-slate-200 bg-white"
              />
            </>
          )}
        </>
      ) : (
        <div role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">לא ניתן לפתוח תצוגה אינטראקטיבית. אפשר לצפות בקוד המקור.</div>
      )}
    </div>
  );
}
