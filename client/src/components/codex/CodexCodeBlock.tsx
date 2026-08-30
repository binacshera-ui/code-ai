import { memo, useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import hljs from 'highlight.js/lib/common';
import { cn } from '@/lib/utils';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHighlightedHtml(code: string, language: string | null) {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }

  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

export const CodexCodeBlock = memo(function CodexCodeBlock({
  code,
  language,
  inline = false,
  className,
}: {
  code: string;
  language?: string | null;
  inline?: boolean;
  className?: string;
}) {
  const normalizedCode = code.replace(/\n$/, '');
  const highlightedHtml = useMemo(
    () => renderHighlightedHtml(normalizedCode, language || null),
    [language, normalizedCode]
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeout = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  if (inline) {
    return (
      <code
        className={cn(
          'inline-flex max-w-full items-center rounded-xl border border-slate-200 bg-slate-50 px-2 py-0.5 font-sans text-[0.92em] font-medium text-slate-700 align-baseline',
          className
        )}
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    );
  }

  return (
    <div className={cn('relative my-3 w-full max-w-full', className)}>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(normalizedCode);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
        className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-900/80 px-3 py-1.5 text-[11px] font-medium text-slate-100 shadow-lg backdrop-blur transition hover:bg-slate-800 active:scale-[0.98]"
        aria-label="העתק קטע קוד"
        title="העתק קטע קוד"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        <span>{copied ? 'הועתק' : 'העתק'}</span>
      </button>
      <pre
        dir="ltr"
        className="overflow-x-hidden overflow-y-auto rounded-[1.25rem] bg-slate-950 p-4 pt-12 text-left text-[13px] leading-6"
      >
        <code
          dir="ltr"
          className="hljs block whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-slate-100"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>
    </div>
  );
});
