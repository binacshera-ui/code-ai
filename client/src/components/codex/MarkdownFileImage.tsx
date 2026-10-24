import { createContext, useContext, useState } from 'react';
import { buildMarkdownImageContentUrl, markdownFileUrlTransform, parseLocalFileHref, withFileSourceServer } from './markdownFiles';

export const MarkdownImageLinkContext = createContext(false);

export function MarkdownFileImage({
  src,
  alt,
  title,
  serverId,
  cwd,
  onOpenFilePreview,
}: {
  src?: string;
  alt?: string;
  title?: string;
  serverId: string;
  cwd?: string | null;
  onOpenFilePreview?: (rawPath: string) => void;
}) {
  const insideLink = useContext(MarkdownImageLinkContext);
  const safeSrc = src ? markdownFileUrlTransform(src, 'src') : '';
  const localFile = safeSrc ? parseLocalFileHref(safeSrc, cwd) : null;
  const sourceKey = `${serverId}\u0000${localFile?.rawPath || safeSrc}`;
  const [attempt, setAttempt] = useState({ sourceKey, retry: 0, failed: false });
  // A source change must clear errors synchronously, before the new image renders.
  const currentAttempt = attempt.sourceKey === sourceKey ? attempt : { sourceKey, retry: 0, failed: false };
  const imageUrl = localFile
    ? buildMarkdownImageContentUrl(localFile.rawPath, serverId, currentAttempt.retry)
    : withFileSourceServer(safeSrc, serverId);
  const label = alt?.trim() || 'תמונה';
  const preview = !insideLink && localFile && onOpenFilePreview
    ? () => onOpenFilePreview(localFile.rawPath) : undefined;

  if (!imageUrl || currentAttempt.failed) {
    return (
      <span dir="auto" className="my-3 inline-flex max-w-full flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600" role="group" aria-label={label}>
        <span className="break-words [overflow-wrap:anywhere]">לא ניתן לטעון את התמונה: {label}</span>
        {imageUrl && !insideLink && (
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs underline"
            onClick={() => setAttempt({ sourceKey, retry: currentAttempt.retry + 1, failed: false })}
          >נסה שוב</button>
        )}
        {preview && (
          <button type="button" className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs underline" onClick={preview}>
            פתח קובץ
          </button>
        )}
      </span>
    );
  }

  const image = (
    <img
      key={`${sourceKey}\u0000${currentAttempt.retry}`}
      src={imageUrl}
      alt={alt || ''}
      title={title}
      dir="auto"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="my-3 block h-auto max-h-[60dvh] max-w-full rounded-xl border border-slate-200 object-contain"
      onError={() => setAttempt({ sourceKey, retry: currentAttempt.retry, failed: true })}
    />
  );
  return preview ? (
    <button type="button" className="block max-w-full text-right" onClick={preview} aria-label={`פתח תצוגה מקדימה: ${label}`}>
      {image}
    </button>
  ) : image;
}
