import path from 'node:path';
import type { CodexFileResolution } from './codexFileResolver.js';

/** A preview namespace is anchored to an already-authorized HTML file. */
export async function resolveCodexPreviewAsset(
  baseToken: string,
  relativeFile: string,
  resolveFile: (target: string) => Promise<CodexFileResolution>,
): Promise<Extract<CodexFileResolution, { kind: 'file' }>['file']> {
  if (!baseToken || baseToken.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(baseToken)) {
    throw new Error('Invalid preview target');
  }
  const basePath = Buffer.from(baseToken, 'base64url').toString('utf8');
  if (Buffer.from(basePath, 'utf8').toString('base64url') !== baseToken
    || !path.isAbsolute(basePath) || !/\.html?$/i.test(basePath) || basePath.includes('\0')) {
    throw new Error('Invalid preview target');
  }
  if (!relativeFile || relativeFile.length > 8_192 || relativeFile.includes('\0')
    || relativeFile.includes('\\') || path.isAbsolute(relativeFile)) {
    throw new Error('Invalid preview asset');
  }
  const base = await resolveFile(basePath);
  if (base.kind !== 'file' || !/\.html?$/i.test(base.file.resolvedPath)) {
    throw new Error('Preview target was not found');
  }
  const directory = path.dirname(base.file.resolvedPath);
  const target = path.resolve(directory, relativeFile);
  const inside = (candidate: string) => {
    const relative = path.relative(directory, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!inside(target)) throw new Error('Preview asset is outside its directory');
  const asset = await resolveFile(target);
  if (asset.kind !== 'file' || !inside(asset.file.resolvedPath)) {
    throw new Error('Preview asset was not found');
  }
  // The source-view route intentionally serves JS as plain text. Executable
  // preview assets need their browser MIME type; keep that change local to this
  // sandboxed namespace rather than changing general source/file downloads.
  return /\.(?:m?js|cjs)$/i.test(asset.file.resolvedPath)
    ? { ...asset.file, mimeType: 'application/javascript; charset=utf-8' }
    : asset.file;
}

/** Only media reads may select a remote server without custom fetch headers. */
export function readCodexFileSourceServer(method: string, routePath: string, serverQuery: unknown): string {
  if (method !== 'GET' && method !== 'HEAD') return '';
  const asset = /^\/files\/asset\/([^/]+)\//.exec(routePath);
  const selected = asset?.[1] || (/^\/files\/(?:content|download)$/.test(routePath)
    && typeof serverQuery === 'string' ? serverQuery : '');
  return /^[a-zA-Z0-9_-]{1,80}$/.test(selected) ? selected.toLowerCase() : '';
}
