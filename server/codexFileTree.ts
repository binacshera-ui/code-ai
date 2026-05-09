import { promises as fs } from 'fs';
import path from 'path';
import {
  getCodexFolderRoots,
  resolveCodexFolderPath,
  type CodexFolderBreadcrumb,
  type CodexFolderRoot,
} from './codexFolderBrowser.js';

export interface CodexFileTreeEntry {
  name: string;
  path: string;
  relativePath: string;
  rootPath: string;
  kind: 'directory' | 'file';
  size: number | null;
  extension: string | null;
}

export interface CodexFileTreeBrowseResult {
  currentPath: string;
  currentName: string;
  rootPath: string;
  parentPath: string | null;
  breadcrumbs: CodexFolderBreadcrumb[];
  entries: CodexFileTreeEntry[];
  roots: CodexFolderRoot[];
  truncated: boolean;
}

const MAX_FILE_TREE_ENTRIES = 1200;

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function realpathIfExists(targetPath: string): Promise<string | null> {
  if (!(await pathExists(targetPath))) {
    return null;
  }

  try {
    return await fs.realpath(targetPath);
  } catch {
    return null;
  }
}

function findContainingRoot(targetPath: string, roots: CodexFolderRoot[]): CodexFolderRoot | null {
  const sortedRoots = [...roots].sort((left, right) => right.path.length - left.path.length);
  return sortedRoots.find((root) => isPathInside(root.path, targetPath)) || null;
}

function buildBreadcrumbs(rootPath: string, currentPath: string): CodexFolderBreadcrumb[] {
  const relative = path.relative(rootPath, currentPath);
  if (!relative || relative === '') {
    return [{ name: path.basename(rootPath) || rootPath, path: rootPath }];
  }

  const crumbs: CodexFolderBreadcrumb[] = [{ name: path.basename(rootPath) || rootPath, path: rootPath }];
  const parts = relative.split(path.sep).filter(Boolean);
  let cursor = rootPath;

  for (const part of parts) {
    cursor = path.join(cursor, part);
    crumbs.push({
      name: part,
      path: cursor,
    });
  }

  return crumbs;
}

export async function browseCodexFileTree(
  requestedPath: string | undefined,
  profileId?: string
): Promise<CodexFileTreeBrowseResult> {
  const { resolvedPath, rootPath } = await resolveCodexFolderPath(requestedPath, profileId);
  const roots = await getCodexFolderRoots(profileId);
  const rawEntries = await fs.readdir(resolvedPath, { withFileTypes: true });
  const entries: CodexFileTreeEntry[] = [];
  let truncated = false;

  for (const entry of rawEntries) {
    if (entries.length >= MAX_FILE_TREE_ENTRIES) {
      truncated = true;
      break;
    }

    const entryPath = path.join(resolvedPath, entry.name);
    const realEntryPath = await realpathIfExists(entryPath);
    if (!realEntryPath) {
      continue;
    }

    if (!findContainingRoot(realEntryPath, roots)) {
      continue;
    }

    const stats = await fs.stat(realEntryPath).catch(() => null);
    if (!stats) {
      continue;
    }

    const kind = stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : null;

    if (!kind) {
      continue;
    }

    entries.push({
      name: entry.name,
      path: realEntryPath,
      relativePath: path.relative(rootPath, realEntryPath) || entry.name,
      rootPath,
      kind,
      size: kind === 'file' ? stats.size : null,
      extension: kind === 'file'
        ? (path.extname(entry.name).slice(1).toLowerCase() || null)
        : null,
    });
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }

    return left.name.localeCompare(right.name, 'he');
  });

  const parentCandidate = path.dirname(resolvedPath);
  const parentPath = parentCandidate !== resolvedPath && findContainingRoot(parentCandidate, roots)
    ? parentCandidate
    : null;

  return {
    currentPath: resolvedPath,
    currentName: path.basename(resolvedPath) || resolvedPath,
    rootPath,
    parentPath,
    breadcrumbs: buildBreadcrumbs(rootPath, resolvedPath),
    entries,
    roots,
    truncated,
  };
}
