import { parse, atRule } from 'postcss';

export type HtmlPreviewFetch = (url: string, init: RequestInit & { signal: AbortSignal }) => Promise<Response>;

export const HTML_PREVIEW_LIMITS = {
  maxAssets: 128,
  maxAssetBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxInlineBytes: 64 * 1024 * 1024,
  maxImportDepth: 12,
};
type Limits = typeof HTML_PREVIEW_LIMITS;
type ResourceKind = 'script' | 'style' | 'image';
type Dependency = { kind: 'local' | 'external' | 'embedded'; url: string } | { kind: 'blocked'; url: '' };
type Asset = { bytes: Uint8Array; mimeType: string };
type AssetKind = 'html' | 'style' | 'script' | 'embedded';

export function htmlPreviewAssetKind(url: string): AssetKind | null {
  const path = url.split(/[?#]/, 1)[0];
  const extension = path.split('.').pop()?.toLowerCase();
  if (['html', 'htm'].includes(extension || '')) return 'html';
  if (extension === 'css') return 'style';
  if (['js', 'mjs', 'cjs'].includes(extension || '')) return 'script';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot',
    'mp3', 'wav', 'ogg', 'm4a', 'opus', 'flac', 'mp4', 'webm', 'ogv', 'mov'].includes(extension || '')) return 'embedded';
  return null;
}

function assetMimeMatches(kind: AssetKind, mime: string): boolean {
  if (kind === 'html') return /^text\/html$/i.test(mime);
  if (kind === 'style') return /^text\/css$/i.test(mime);
  if (kind === 'script') return /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)$/i.test(mime);
  return /^(?:image|font|audio|video)\//i.test(mime)
    || /^application\/(?:font[-+]|x-font-|vnd\.ms-fontobject$)/i.test(mime);
}

export class HtmlPreviewLimitError extends Error {}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Preview loading was cancelled', 'AbortError');
}

export function htmlPreviewNamespace(assetUrl: string, origin: string): string | null {
  try {
    const url = new URL(assetUrl, origin);
    const match = url.pathname.match(/^\/api\/codex\/files\/asset\/[A-Za-z0-9._-]+\/[A-Za-z0-9_-]+\//);
    return url.origin === origin && match ? match[0] : null;
  } catch {
    return null;
  }
}

/** Never ask the authenticated parent to fetch external sites or arbitrary API paths. */
export function resolveHtmlPreviewDependency(value: string, sourceUrl: string, namespace: string, origin: string): Dependency {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\\]/.test(trimmed)) return { kind: 'blocked', url: '' };
  if (trimmed.startsWith('#') || /^(?:data:|blob:)/i.test(trimmed)) return { kind: 'embedded', url: trimmed };
  try {
    // Root-relative website assets mean the preview directory, never the app root.
    const target = trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/api/')
      ? `${namespace}${trimmed.slice(1)}` : trimmed;
    const url = new URL(target, new URL(sourceUrl, origin));
    if (url.username || url.password) return { kind: 'blocked', url: '' };
    if (url.origin !== origin) return url.protocol === 'https:'
      ? { kind: 'external', url: url.href } : { kind: 'blocked', url: '' };
    if (!url.pathname.startsWith(namespace) || /%(?:2f|5c|00)/i.test(url.pathname)) return { kind: 'blocked', url: '' };
    // Asset query strings are cache hints, not source-server or access selectors.
    url.search = '';
    return { kind: 'local', url: `${url.pathname}${url.hash}` };
  } catch {
    return { kind: 'blocked', url: '' };
  }
}

function inferredMimeType(url: string, header: string | null): string {
  const mime = header?.split(';')[0].trim();
  if (mime && mime !== 'application/octet-stream' && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mime)) return mime;
  const extension = url.split('#')[0].split('.').pop()?.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    otf: 'font/otf', eot: 'application/vnd.ms-fontobject', bmp: 'image/bmp', ico: 'image/x-icon',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', opus: 'audio/ogg', flac: 'audio/flac',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
    css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', html: 'text/html', htm: 'text/html',
  } as Record<string, string>)[extension || ''] || 'application/octet-stream';
}

function bytesToDataUrl(asset: Asset): string {
  const chunks: string[] = [];
  for (let index = 0; index < asset.bytes.length; index += 0x8000) {
    chunks.push(String.fromCharCode(...asset.bytes.subarray(index, index + 0x8000)));
  }
  return `data:${asset.mimeType};base64,${btoa(chunks.join(''))}`;
}

export function createHtmlPreviewContext(options: {
  assetUrl: string;
  origin: string;
  signal: AbortSignal;
  fetchFile: HtmlPreviewFetch;
  limits?: Partial<Limits>;
}) {
  const namespace = htmlPreviewNamespace(options.assetUrl, options.origin);
  if (!namespace) throw new Error('Invalid authenticated HTML preview location');
  const limits = { ...HTML_PREVIEW_LIMITS, ...options.limits };
  const assets = new Map<string, Promise<Asset>>();
  const embeddedAssets = new Map<string, Promise<string>>();
  const warnings = new Set<string>();
  const externalOrigins = new Set<string>();
  const externalScriptOrigins = new Set<string>();
  let totalBytes = 0;
  let inlineBytes = 0;

  function warn(message: string) {
    if (warnings.size < 20) warnings.add(message);
  }
  function reserveInline(value: string) {
    inlineBytes += new TextEncoder().encode(value).byteLength;
    if (inlineBytes > limits.maxInlineBytes) throw new HtmlPreviewLimitError('HTML preview dependency output exceeds the memory limit');
  }
  function dependency(value: string, sourceUrl: string, kind: ResourceKind = 'image') {
    const resolved = resolveHtmlPreviewDependency(value, sourceUrl, namespace!, options.origin);
    if (resolved.kind === 'external') {
      const externalOrigin = new URL(resolved.url).origin;
      externalOrigins.add(externalOrigin);
      if (kind === 'script') externalScriptOrigins.add(externalOrigin);
    }
    if (resolved.kind === 'blocked') warn('תלות מחוץ לתיקיית התצוגה או כתובת שאינה נתמכת נחסמה.');
    return resolved;
  }
  async function fetchAsset(url: string, expectedKind?: AssetKind): Promise<Asset> {
    checkAbort(options.signal);
    const resolved = resolveHtmlPreviewDependency(url, options.assetUrl, namespace!, options.origin);
    if (resolved.kind !== 'local') throw new Error('Only directory-scoped preview files may be fetched with authentication');
    const key = resolved.url.split('#')[0];
    const kind = htmlPreviewAssetKind(key);
    if (!kind || (expectedKind && expectedKind !== kind)) throw new Error('This file type is not an HTML preview dependency');
    const cached = assets.get(key);
    if (cached) return cached;
    if (assets.size >= limits.maxAssets) throw new HtmlPreviewLimitError('HTML preview has too many dependencies');
    const pending = (async () => {
      const response = await options.fetchFile(key, { signal: options.signal, redirect: 'error', credentials: 'same-origin' });
      checkAbort(options.signal);
      if (!response.ok) throw new Error(`Preview dependency could not be loaded (${response.status})`);
      if (response.redirected) throw new Error('Preview dependency redirects are not allowed');
      const mimeType = inferredMimeType(key, response.headers.get('content-type'));
      if (!assetMimeMatches(kind, mimeType)) throw new Error('Preview dependency MIME type does not match its resource kind');
      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > limits.maxAssetBytes) throw new HtmlPreviewLimitError('A preview file exceeds the size limit');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const account = (chunk: Uint8Array) => {
        size += chunk.byteLength;
        totalBytes += chunk.byteLength;
        if (size > limits.maxAssetBytes || totalBytes > limits.maxTotalBytes) throw new HtmlPreviewLimitError('HTML preview files exceed the memory limit');
        chunks.push(chunk);
      };
      if (response.body) {
        const reader = response.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => undefined); };
        options.signal.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            checkAbort(options.signal);
            const result = await reader.read();
            checkAbort(options.signal);
            if (result.done) break;
            account(result.value);
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        } finally {
          options.signal.removeEventListener('abort', cancel);
          reader.releaseLock();
        }
      } else account(new Uint8Array(await response.arrayBuffer()));
      checkAbort(options.signal);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { bytes, mimeType };
    })();
    assets.set(key, pending);
    return pending;
  }
  async function optional<T>(load: () => Promise<T>, fallback: T): Promise<T> {
    try { return await load(); }
    catch (error) {
      checkAbort(options.signal);
      if (error instanceof HtmlPreviewLimitError) throw error;
      warn('אחד מקובצי העיצוב, התמונה או הסקריפט לא נטען; התצוגה עשויה להיות חלקית.');
      return fallback;
    }
  }
  async function inlineAsset(url: string): Promise<string> {
    const [key, fragment] = url.split('#', 2);
    if (!embeddedAssets.has(key)) embeddedAssets.set(key, fetchAsset(key, 'embedded').then(bytesToDataUrl));
    const result = `${await embeddedAssets.get(key)}${fragment ? `#${fragment}` : ''}`;
    reserveInline(result);
    return result;
  }
  function csp() {
    const passive = [...externalOrigins].join(' ');
    const scripts = [...externalScriptOrigins].join(' ');
    return `default-src 'none'; script-src 'unsafe-inline' data: blob: ${scripts}; style-src 'unsafe-inline' data: blob: ${passive}; img-src data: blob: ${passive}; font-src data: blob: ${passive}; media-src data: blob: ${passive}; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
  }
  return { ...options, namespace, limits, warnings, warn, dependency, fetchAsset, inlineAsset, optional, reserveInline, csp };
}
export type HtmlPreviewContext = ReturnType<typeof createHtmlPreviewContext>;

function decodeCssValue(value: string): string {
  return value.replace(/\\(?:([0-9a-f]{1,6})\s?|([^\r\n\f]))/gi, (_whole, hex, literal) => {
    const code = hex ? Number.parseInt(hex, 16) : 0;
    return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd) : literal;
  });
}

/** A narrow URL-value lexer; PostCSS owns the actual stylesheet grammar. */
export function cssPreviewUrlReferences(value: string): Array<{ start: number; end: number; value: string }> {
  const references: Array<{ start: number; end: number; value: string }> = [];
  for (let index = 0; index < value.length;) {
    if (value.slice(index, index + 2) === '/*') {
      const end = value.indexOf('*/', index + 2); index = end < 0 ? value.length : end + 2; continue;
    }
    if (value[index] === '"' || value[index] === "'") {
      const quote = value[index++];
      while (index < value.length && value[index] !== quote) index += value[index] === '\\' ? 2 : 1;
      index += 1; continue;
    }
    const match = value.slice(index).match(/^url\s*\(/i);
    if (!match || (index > 0 && /[\w-]/.test(value[index - 1]))) { index += 1; continue; }
    const start = index;
    index += match[0].length;
    while (/\s/.test(value[index] || '') && index < value.length) index += 1;
    const quote = value[index] === '"' || value[index] === "'" ? value[index++] : null;
    const valueStart = index;
    while (index < value.length && value[index] !== (quote || ')')) index += value[index] === '\\' ? 2 : 1;
    const raw = value.slice(valueStart, index).trim();
    if (quote) { index += 1; while (/\s/.test(value[index] || '') && index < value.length) index += 1; }
    if (value[index] !== ')') continue;
    references.push({ start, end: ++index, value: decodeCssValue(raw) });
  }
  return references;
}

async function rewriteCssUrls(value: string, sourceUrl: string, context: HtmlPreviewContext): Promise<string> {
  let result = value;
  for (const reference of cssPreviewUrlReferences(value).reverse()) {
    const resolved = context.dependency(reference.value, sourceUrl);
    const target = resolved.kind === 'local'
      ? await context.optional(() => context.inlineAsset(resolved.url), '') : resolved.url;
    result = `${result.slice(0, reference.start)}url("${target.replace(/"/g, '%22')}")${result.slice(reference.end)}`;
  }
  return result;
}

export async function inlineHtmlPreviewCss(css: string, sourceUrl: string, context: HtmlPreviewContext, ancestors: string[] = []): Promise<string> {
  checkAbort(context.signal);
  if (ancestors.includes(sourceUrl)) { context.warn('יבוא CSS מעגלי נחסם.'); return ''; }
  if (ancestors.length >= context.limits.maxImportDepth) throw new HtmlPreviewLimitError('CSS imports exceed the depth limit');
  const root = parse(css, { map: false });
  const imports: import('postcss').AtRule[] = [];
  root.walkAtRules(/^import$/i, (rule) => { imports.push(rule); });
  for (const rule of imports) {
    const urlReference = cssPreviewUrlReferences(rule.params)[0];
    const quoted = rule.params.match(/^\s*(["'])((?:\\.|(?!\1).)*)\1/);
    const rawUrl = urlReference?.start === 0 ? urlReference.value : quoted ? decodeCssValue(quoted[2]) : null;
    const end = urlReference?.start === 0 ? urlReference.end : quoted?.[0].length || 0;
    if (!rawUrl) { rule.remove(); context.warn('יבוא CSS שאינו נתמך נחסם.'); continue; }
    const resolved = context.dependency(rawUrl, sourceUrl, 'style');
    if (resolved.kind === 'external') { rule.params = `url("${resolved.url}")${rule.params.slice(end)}`; continue; }
    if (resolved.kind !== 'local') { rule.remove(); continue; }
    const tail = rule.params.slice(end).trim();
    if (/^(?:layer|supports)\b/i.test(tail)) { rule.remove(); context.warn('יבוא CSS עם layer/supports אינו נתמך בתצוגה המבודדת.'); continue; }
    const imported = await context.optional(async () => {
      const asset = await context.fetchAsset(resolved.url, 'style');
      return inlineHtmlPreviewCss(new TextDecoder().decode(asset.bytes), resolved.url, context, [...ancestors, sourceUrl]);
    }, '');
    const importedRoot = parse(imported, { map: false });
    if (tail) {
      const media = atRule({ name: 'media', params: tail });
      media.append(importedRoot.nodes);
      rule.replaceWith(media);
    } else rule.replaceWith(...importedRoot.nodes);
  }
  const declarations: import('postcss').Declaration[] = [];
  root.walkDecls((declaration) => { declarations.push(declaration); });
  for (const declaration of declarations) declaration.value = await rewriteCssUrls(declaration.value, sourceUrl, context);
  return root.toString();
}

export function escapeHtmlPreviewRawText(value: string, tag: 'script' | 'style'): string {
  return value.replace(new RegExp(`</${tag}`, 'gi'), (closing) => closing.replace('</', '<\\/'));
}

export function hasHtmlPreviewModuleImports(source: string): boolean {
  return /\bimport\s*(?:\(|['"{*]|[A-Za-z_$][\w$]*\s*(?:,|from\b))|\bexport\s+[^;\n]*\bfrom\s*['"]/m.test(source);
}

export function htmlPreviewSrcsetCandidates(value: string): Array<{ url: string; descriptor: string }> {
  const candidates: Array<{ url: string; descriptor: string }> = [];
  let index = 0;
  while (index < value.length) {
    while (/[\s,]/.test(value[index] || '') && index < value.length) index += 1;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index += 1;
    const token = value.slice(start, index);
    if (!token) break;
    if (token.endsWith(',')) { candidates.push({ url: token.replace(/,+$/, ''), descriptor: '' }); continue; }
    const descriptorStart = index;
    while (index < value.length && value[index] !== ',') index += 1;
    candidates.push({ url: token, descriptor: value.slice(descriptorStart, index).trim() });
    index += 1;
  }
  return candidates;
}

export async function prepareHtmlPreviewDocument(options: Parameters<typeof createHtmlPreviewContext>[0]): Promise<{ srcDoc: string; warnings: string[] }> {
  const context = createHtmlPreviewContext(options);
  const html = new TextDecoder().decode((await context.fetchAsset(options.assetUrl, 'html')).bytes);
  // DOMParser creates an inert detached document. Never append it to the app DOM.
  const document = new DOMParser().parseFromString(html, 'text/html');
  document.querySelectorAll('base, meta[http-equiv="refresh" i], meta[http-equiv="content-security-policy" i], iframe, object, embed').forEach((node) => node.remove());
  const originalStyles = [...document.querySelectorAll('style')];
  for (const link of document.querySelectorAll('link')) {
    if (link.rel.toLowerCase() !== 'stylesheet') { link.remove(); continue; }
    const resolved = context.dependency(link.getAttribute('href') || '', options.assetUrl, 'style');
    if (resolved.kind === 'external') { link.href = resolved.url; continue; }
    if (resolved.kind !== 'local') { link.remove(); continue; }
    const css = await context.optional(async () => inlineHtmlPreviewCss(
      new TextDecoder().decode((await context.fetchAsset(resolved.url, 'style')).bytes), resolved.url, context,
    ), '');
    context.reserveInline(css);
    const style = document.createElement('style');
    if (link.media) style.media = link.media;
    style.textContent = escapeHtmlPreviewRawText(css, 'style');
    link.replaceWith(style);
  }
  for (const style of originalStyles) {
    const css = await context.optional(() => inlineHtmlPreviewCss(style.textContent || '', options.assetUrl, context), '');
    context.reserveInline(css);
    style.textContent = escapeHtmlPreviewRawText(css, 'style');
  }
  for (const node of document.querySelectorAll<HTMLElement>('[style]')) {
    node.setAttribute('style', await context.optional(() => inlineHtmlPreviewCss(node.getAttribute('style') || '', options.assetUrl, context), ''));
  }
  for (const script of document.querySelectorAll('script')) {
    const type = script.type.trim().toLowerCase();
    if (type && !['module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)) continue;
    let source = script.textContent || '';
    const src = script.getAttribute('src');
    if (src) {
      const resolved = context.dependency(src, options.assetUrl, 'script');
      if (resolved.kind === 'external') { script.src = resolved.url; continue; }
      if (resolved.kind !== 'local') { script.remove(); continue; }
      const loaded = await context.optional<string | null>(async () => new TextDecoder().decode((await context.fetchAsset(resolved.url, 'script')).bytes), null);
      if (loaded === null) { script.remove(); continue; }
      source = loaded;
      script.removeAttribute('src');
      script.removeAttribute('integrity');
      script.removeAttribute('crossorigin');
    }
    if (type === 'module' && hasHtmlPreviewModuleImports(source)) {
      script.remove();
      context.warn('סקריפט מודול עם import אינו נתמך בתצוגה המבודדת; רכיב זה לא הופעל.');
      continue;
    }
    context.reserveInline(source);
    script.textContent = escapeHtmlPreviewRawText(source, 'script');
    if (src && (script.defer || script.async)) {
      script.removeAttribute('defer'); script.removeAttribute('async');
      document.body.appendChild(script);
    }
  }
  async function rewriteAttribute(node: Element, attribute: string) {
    const value = node.getAttribute(attribute);
    if (!value) return;
    const resolved = context.dependency(value, options.assetUrl);
    const result = resolved.kind === 'local' ? await context.optional(() => context.inlineAsset(resolved.url), '') : resolved.url;
    if (result) node.setAttribute(attribute, result); else node.removeAttribute(attribute);
  }
  for (const node of document.querySelectorAll('img, input[type="image"], audio, video, source, track, image')) {
    for (const attribute of ['src', 'poster', 'href', 'xlink:href']) await rewriteAttribute(node, attribute);
    if (node.hasAttribute('srcset')) {
      const candidates: string[] = [];
      for (const candidate of htmlPreviewSrcsetCandidates(node.getAttribute('srcset') || '')) {
        const resolved = context.dependency(candidate.url, options.assetUrl);
        const url = resolved.kind === 'local' ? await context.optional(() => context.inlineAsset(resolved.url), '') : resolved.url;
        if (url) candidates.push(`${url}${candidate.descriptor ? ` ${candidate.descriptor}` : ''}`);
      }
      if (candidates.length) node.setAttribute('srcset', candidates.join(', ')); else node.removeAttribute('srcset');
    }
  }
  // These are navigation, not dependency loading; no application authority is inherited.
  document.querySelectorAll('form').forEach((form) => form.removeAttribute('action'));
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = context.csp();
  document.head.prepend(csp);
  checkAbort(options.signal);
  const srcDoc = `<!doctype html>\n${document.documentElement.outerHTML}`;
  if (new TextEncoder().encode(srcDoc).byteLength > context.limits.maxInlineBytes) throw new HtmlPreviewLimitError('Prepared HTML preview exceeds the memory limit');
  return { srcDoc, warnings: [...context.warnings] };
}
