import { Dirent, promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
export const MAX_PREVIEW_FILE_BYTES = 100 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 12;
const ALLOWED_FILE_ROOTS = CODEX_APP_CONFIG.allowedFileRoots;
const SEARCH_FILE_ROOTS = CODEX_APP_CONFIG.searchableFileRoots;

const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.log',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.html',
  '.py',
  '.sh',
  '.yaml',
  '.yml',
  '.xml',
  '.ini',
  '.conf',
  '.env',
  '.java',
  '.go',
  '.rs',
  '.php',
  '.rb',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.sql',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.py',
  '.sh',
  '.yaml',
  '.yml',
  '.java',
  '.go',
  '.rs',
  '.php',
  '.rb',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.sql',
  '.json',
  '.xml',
  '.toml',
  '.ini',
]);

const SEARCH_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'coverage',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

export type CodexPreviewKind =
  | 'markdown'
  | 'code'
  | 'text'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'embed'
  | 'binary';

export interface CodexResolvedFile {
  resolvedPath: string;
  displayPath: string;
  lineNumber: number | null;
  stats: Awaited<ReturnType<typeof fs.stat>>;
  extension: string;
  mimeType: string | false;
  previewKind: CodexPreviewKind;
  isMarkdown: boolean;
  isText: boolean;
  codeLanguage: string | null;
  content: string | null;
  truncated: boolean;
}

export interface CodexFileMatch {
  path: string;
  name: string;
  relativePath: string;
  rootPath: string;
  size: number;
  updatedAt: string;
}

export type CodexFileResolution =
  | {
      kind: 'file';
      file: CodexResolvedFile;
    }
  | {
      kind: 'matches';
      query: string;
      lineNumber: number | null;
      matches: CodexFileMatch[];
    };

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedPreviewPath(targetPath: string): boolean {
  if (!path.isAbsolute(targetPath)) {
    return false;
  }

  return ALLOWED_FILE_ROOTS.some((rootPath) => isPathInside(rootPath, targetPath));
}

function stripFileProtocol(rawValue: string) {
  if (!rawValue.startsWith('file://')) {
    return rawValue;
  }

  try {
    return new URL(rawValue).pathname;
  } catch {
    return rawValue.replace(/^file:\/\//, '');
  }
}

export function decodeFileTarget(rawValue: string): { filePath: string; lineNumber: number | null } {
  const decoded = stripFileProtocol(decodeURIComponent(rawValue).trim());
  const lineMatch = decoded.match(/^(.*?):(\d+)$/);

  if (lineMatch && lineMatch[1]) {
    return {
      filePath: lineMatch[1],
      lineNumber: Number.parseInt(lineMatch[2], 10),
    };
  }

  return {
    filePath: decoded,
    lineNumber: null,
  };
}

function normalizeRelativeQuery(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .trim();
}

function lookupMimeTypeFromPath(filePath: string): string | false {
  const extension = path.extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[extension] || false;
}

async function statAllowedFile(candidatePath: string) {
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isAllowedPreviewPath(resolvedCandidate)) {
    return null;
  }

  const initialStats = await fs.stat(resolvedCandidate);
  if (!initialStats.isFile()) {
    return null;
  }

  const realPath = await fs.realpath(resolvedCandidate).catch(() => resolvedCandidate);
  if (!isAllowedPreviewPath(realPath)) {
    return null;
  }

  const stats = realPath === resolvedCandidate ? initialStats : await fs.stat(realPath);
  if (!stats.isFile()) {
    return null;
  }

  return {
    resolvedPath: realPath,
    stats,
  };
}

function getCodeLanguage(extension: string, mimeType: string | false): string | null {
  const byExtension: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'scss',
    '.less': 'css',
    '.html': 'xml',
    '.xml': 'xml',
    '.svg': 'xml',
    '.py': 'python',
    '.sh': 'bash',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.json': 'json',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.php': 'php',
    '.rb': 'ruby',
    '.c': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.sql': 'sql',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.toml': 'ini',
    '.ini': 'ini',
    '.conf': 'ini',
  };

  if (byExtension[extension]) {
    return byExtension[extension];
  }

  if (typeof mimeType === 'string' && mimeType.includes('json')) return 'json';
  if (typeof mimeType === 'string' && mimeType.includes('xml')) return 'xml';
  if (typeof mimeType === 'string' && mimeType.includes('javascript')) return 'javascript';

  return null;
}

function detectPreviewKind(extension: string, mimeType: string | false): CodexPreviewKind {
  if (extension === '.md' || extension === '.markdown') {
    return 'markdown';
  }

  if (typeof mimeType === 'string' && mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType === 'application/pdf') {
    return 'pdf';
  }

  if (typeof mimeType === 'string' && mimeType.startsWith('audio/')) {
    return 'audio';
  }

  if (typeof mimeType === 'string' && mimeType.startsWith('video/')) {
    return 'video';
  }

  if (CODE_EXTENSIONS.has(extension)) {
    return 'code';
  }

  if (TEXT_PREVIEW_EXTENSIONS.has(extension) || (typeof mimeType === 'string' && mimeType.startsWith('text/'))) {
    return 'text';
  }

  if (mimeType) {
    return 'embed';
  }

  return 'binary';
}

async function readTextPreview(filePath: string, fileSize: number) {
  const previewBytes = Math.min(fileSize, MAX_TEXT_PREVIEW_BYTES);
  if (previewBytes <= 0) {
    return { content: '', truncated: false };
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(previewBytes);
    const { bytesRead } = await handle.read(buffer, 0, previewBytes, 0);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf-8'),
      truncated: fileSize > previewBytes,
    };
  } finally {
    await handle.close();
  }
}

function buildMatch(rootPath: string, resolvedPath: string, stats: Awaited<ReturnType<typeof fs.stat>>): CodexFileMatch {
  return {
    path: resolvedPath,
    name: path.basename(resolvedPath),
    relativePath: path.relative(rootPath, resolvedPath) || path.basename(resolvedPath),
    rootPath,
    size: Number(stats.size),
    updatedAt: stats.mtime.toISOString(),
  };
}

async function resolveAbsoluteFile(filePath: string, lineNumber: number | null): Promise<CodexFileResolution> {
  const fileRecord = await statAllowedFile(filePath);
  if (!fileRecord) {
    throw new Error('File path is not allowed or was not found');
  }

  const extension = path.extname(fileRecord.resolvedPath).toLowerCase();
  const mimeType = lookupMimeTypeFromPath(fileRecord.resolvedPath);
  const previewKind = detectPreviewKind(extension, mimeType);
  const isMarkdown = previewKind === 'markdown';
  const isText = previewKind === 'markdown' || previewKind === 'code' || previewKind === 'text';
  const codeLanguage = getCodeLanguage(extension, mimeType);
  const textPreview = isText
    ? await readTextPreview(fileRecord.resolvedPath, Number(fileRecord.stats.size))
    : { content: null, truncated: false };

  return {
    kind: 'file',
    file: {
      resolvedPath: fileRecord.resolvedPath,
      displayPath: fileRecord.resolvedPath,
      lineNumber,
      stats: fileRecord.stats,
      extension,
      mimeType,
      previewKind,
      isMarkdown,
      isText,
      codeLanguage,
      content: textPreview.content,
      truncated: textPreview.truncated,
    },
  };
}

async function resolveDirectRelativeMatches(query: string) {
  const matches: CodexFileMatch[] = [];
  const seen = new Set<string>();

  await Promise.all(SEARCH_FILE_ROOTS.map(async (rootPath) => {
    const candidate = path.resolve(rootPath, query);
    if (!isPathInside(rootPath, candidate)) {
      return;
    }

    try {
      const fileRecord = await statAllowedFile(candidate);
      if (!fileRecord || seen.has(fileRecord.resolvedPath)) {
        return;
      }
      seen.add(fileRecord.resolvedPath);
      matches.push(buildMatch(rootPath, fileRecord.resolvedPath, fileRecord.stats));
    } catch {
      // Ignore missing relative candidates and continue searching.
    }
  }));

  return matches;
}

function scoreCandidateMatch(relativePath: string, fileName: string, normalizedQuery: string, basenameQuery: string) {
  const lowerRelative = relativePath.replace(/\\/g, '/').toLowerCase();
  const lowerFileName = fileName.toLowerCase();

  if (lowerRelative === normalizedQuery) {
    return 0;
  }

  if (normalizedQuery.includes('/') && lowerRelative.endsWith(`/${normalizedQuery}`)) {
    return 1;
  }

  if (lowerFileName === basenameQuery) {
    return 2;
  }

  return null;
}

async function searchRelativeMatches(query: string) {
  const normalizedQuery = normalizeRelativeQuery(query).toLowerCase();
  const basenameQuery = path.posix.basename(normalizedQuery);
  const collected: Array<{ score: number; match: CodexFileMatch }> = [];
  const seen = new Set<string>();

  async function visitDirectory(rootPath: string, directoryPath: string) {
    if (collected.length >= MAX_SEARCH_MATCHES) {
      return;
    }

    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (collected.length >= MAX_SEARCH_MATCHES) {
        return;
      }

      const candidatePath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        await visitDirectory(rootPath, candidatePath);
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }

      const relativePath = path.relative(rootPath, candidatePath);
      const score = scoreCandidateMatch(relativePath, entry.name, normalizedQuery, basenameQuery);
      if (score === null) {
        continue;
      }

      try {
        const fileRecord = await statAllowedFile(candidatePath);
        if (!fileRecord || seen.has(fileRecord.resolvedPath)) {
          continue;
        }

        seen.add(fileRecord.resolvedPath);
        collected.push({
          score,
          match: buildMatch(rootPath, fileRecord.resolvedPath, fileRecord.stats),
        });
      } catch {
        // Ignore single candidate failures and continue with the search.
      }
    }
  }

  for (const rootPath of SEARCH_FILE_ROOTS) {
    await visitDirectory(rootPath, rootPath);
    if (collected.length >= MAX_SEARCH_MATCHES) {
      break;
    }
  }

  return collected
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return right.match.updatedAt.localeCompare(left.match.updatedAt);
    })
    .map((entry) => entry.match);
}

export async function resolveCodexFileTarget(rawTarget: string): Promise<CodexFileResolution> {
  const { filePath, lineNumber } = decodeFileTarget(rawTarget);
  if (!filePath.trim()) {
    throw new Error('File path is required');
  }

  if (path.isAbsolute(filePath)) {
    return resolveAbsoluteFile(filePath, lineNumber);
  }

  const normalizedQuery = normalizeRelativeQuery(filePath);
  if (!normalizedQuery) {
    throw new Error('File path is required');
  }

  const directMatches = await resolveDirectRelativeMatches(normalizedQuery);
  if (directMatches.length === 1) {
    return resolveAbsoluteFile(directMatches[0].path, lineNumber);
  }

  if (directMatches.length > 1) {
    return {
      kind: 'matches',
      query: normalizedQuery,
      lineNumber,
      matches: directMatches
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_SEARCH_MATCHES),
    };
  }

  const searchMatches = await searchRelativeMatches(normalizedQuery);
  if (searchMatches.length === 1) {
    return resolveAbsoluteFile(searchMatches[0].path, lineNumber);
  }

  if (searchMatches.length > 1) {
    return {
      kind: 'matches',
      query: normalizedQuery,
      lineNumber,
      matches: searchMatches.slice(0, MAX_SEARCH_MATCHES),
    };
  }

  throw new Error('File was not found on the server');
}
