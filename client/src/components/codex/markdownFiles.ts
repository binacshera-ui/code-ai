import { defaultUrlTransform } from 'react-markdown';

function safeDecodeFilePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    try {
      return decodeURIComponent(value.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
    } catch {
      return value;
    }
  }
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function normalizeFilePath(value: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  const normalized = windows ? value.replace(/\\/g, '/') : value;
  const prefix = normalized.startsWith('//') ? '//'
    : /^[A-Za-z]:\//.test(normalized) ? normalized.slice(0, 3)
      : normalized.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of normalized.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (part !== '..' || !prefix) parts.push(part);
  }
  const result = `${prefix}${parts.join('/')}`;
  return windows ? result.replace(/\//g, '\\') : result;
}

/** Classify only filesystem destinations. Other schemes keep Markdown's URL policy. */
export function parseLocalFileHref(href: string, cwd?: string | null): { rawPath: string } | null {
  let decoded = safeDecodeFilePath(href).trim();
  if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)
    || decoded.startsWith('#') || decoded.startsWith('//')
    || decoded.startsWith('/api/')) return null;

  if (/^file:\/\//i.test(decoded)) {
    try {
      // Parse the undecoded URL, so literal encoded delimiters stay in the path.
      const fileUrl = new URL(href.trim());
      if (fileUrl.username || fileUrl.password || fileUrl.port) return null;
      const pathname = safeDecodeFilePath(fileUrl.pathname);
      decoded = fileUrl.hostname && fileUrl.hostname !== 'localhost'
        ? `\\\\${fileUrl.hostname}${pathname.replace(/\//g, '\\')}`
        : pathname.replace(/^\/([A-Za-z]:[\\/])/, '$1');
      decoded += fileUrl.hash;
    } catch {
      return null;
    }
    if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)
    && !/^[A-Za-z]:[\\/]/.test(decoded)
    && !/^[^:#?]+\.[A-Za-z0-9_-]+:\d+(?::\d+)?$/.test(decoded)) {
    return null;
  }

  if (cwd && isAbsoluteFilePath(cwd) && !isAbsoluteFilePath(decoded) && !decoded.startsWith('~')) {
    decoded = normalizeFilePath(`${cwd.replace(/[\\/]$/, '')}/${decoded}`);
  }
  return { rawPath: decoded };
}

/** Retain local file schemes only for the two product-owned renderers. */
export function markdownFileUrlTransform(url: string, key: string): string {
  if ((key === 'href' || key === 'src') && parseLocalFileHref(url)) return url;
  return defaultUrlTransform(url);
}

export function withFileSourceServer(url: string, serverId: string): string {
  // Never attach internal source context to an external URL.
  if (!url.startsWith('/api/codex/files/')) return url;
  const [withoutHash, hash] = url.split('#', 2);
  const queryIndex = withoutHash.indexOf('?');
  const pathname = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? '' : withoutHash.slice(queryIndex + 1));
  query.set('server', serverId.trim().toLowerCase() || 'local');
  return `${pathname}?${query.toString()}${hash ? `#${hash}` : ''}`;
}

export function buildMarkdownImageContentUrl(rawPath: string, serverId: string, retry = 0): string {
  const query = new URLSearchParams({ path: rawPath, server: serverId.trim().toLowerCase() || 'local' });
  if (retry > 0) query.set('retry', String(retry));
  return `/api/codex/files/content?${query.toString()}`;
}

export function filePreviewDirectory(path: string): string | null {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSlash === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3);
  return lastSlash < 0 ? null : path.slice(0, lastSlash) || '/';
}

export function isHtmlFilePreview(file: { extension: string; mimeType: string }): boolean {
  return /^\.?html?$/i.test(file.extension) || /^text\/html(?:;|$)/i.test(file.mimeType);
}

export function buildHtmlFilePreviewUrl(contentUrl: string, serverId: string): string | null {
  if (!contentUrl.startsWith('/api/codex/files/content?')) return null;
  const path = new URLSearchParams(contentUrl.slice(contentUrl.indexOf('?') + 1)).get('path');
  if (!path || !isAbsoluteFilePath(path)) return null;
  const bytes = new TextEncoder().encode(path);
  // btoa encodes bytes, not UTF-16; Hebrew filenames must survive the token.
  const token = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const basename = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  if (!basename) return null;
  return `/api/codex/files/asset/${encodeURIComponent(serverId.trim().toLowerCase() || 'local')}/${token}/${encodeURIComponent(basename)}`;
}
