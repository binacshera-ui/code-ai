import { memo, useMemo } from 'react';
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

  if (inline) {
    return (
      <code
        className={cn(
          'rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[0.9em] text-slate-900',
          className
        )}
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    );
  }

  return (
    <pre className={cn('overflow-x-auto rounded-[1.25rem] bg-slate-950 p-4 text-left text-[13px] leading-6', className)}>
      <code
        dir="ltr"
        className="hljs block min-w-full whitespace-pre font-mono text-slate-100"
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    </pre>
  );
});
