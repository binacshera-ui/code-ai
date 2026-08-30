import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG, type CodexProfileConfig } from './config.js';

export interface CodexFolderRoot {
  label: string;
  path: string;
}

export interface CodexFolderEntry {
  name: string;
  path: string;
  relativePath: string;
  rootPath: string;
}

export interface CodexFolderBreadcrumb {
  name: string;
  path: string;
}

export interface CodexFolderBrowseResult {
  currentPath: string;
  currentName: string;
  rootPath: string;
  parentPath: string | null;
  breadcrumbs: CodexFolderBreadcrumb[];
  entries: CodexFolderEntry[];
  roots: CodexFolderRoot[];
}

const MAX_FOLDER_ENTRIES = 400;

function normalizeSuggestionInput(value: string): string {
  return value.trim().toLowerCase();
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previous = new Array(right.length + 1).fill(0).map((_, index) => index);
  const current = new Array(right.length + 1).fill(0);

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + substitutionCost
      );
    }

    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = current[column];
    }
  }

  return previous[right.length];
}

async function suggestNearbyDirectory(targetPath: string): Promise<string | null> {
  const parentPath = path.dirname(targetPath);
  const requestedName = path.basename(targetPath);

  if (!requestedName || requestedName === '.' || requestedName === '..') {
    return null;
  }

  const parentRealPath = await realpathIfExists(parentPath);
  if (!parentRealPath) {
    return null;
  }

  const entries = await fs.readdir(parentRealPath, { withFileTypes: true }).catch(() => []);
  const requestedNormalized = normalizeSuggestionInput(requestedName);
  let bestMatch: { path: string; distance: number } | null = null;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidateNormalized = normalizeSuggestionInput(entry.name);
    const distance = levenshteinDistance(requestedNormalized, candidateNormalized);
    const isLoosePrefixMatch = candidateNormalized.includes(requestedNormalized) || requestedNormalized.includes(candidateNormalized);

    if (distance > 4 && !isLoosePrefixMatch) {
      continue;
    }

    const candidatePath = path.join(parentRealPath, entry.name);
    if (!bestMatch || distance < bestMatch.distance) {
      bestMatch = { path: candidatePath, distance };
    }
  }

  return bestMatch?.path || null;
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveProfile(profileId?: string): CodexProfileConfig {
  const profile = CODEX_APP_CONFIG.profiles.find((candidate) => candidate.id === profileId)
    || CODEX_APP_CONFIG.profiles.find((candidate) => candidate.defaultProfile)
    || CODEX_APP_CONFIG.profiles[0];

  if (!profile) {
    throw new Error('No Codex profile is configured');
  }

  return profile;
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

function listPathAncestors(targetPath: string): string[] {
  const ancestors: string[] = [];
  let cursor = path.resolve(targetPath);

  while (true) {
    ancestors.push(cursor);
    const parentPath = path.dirname(cursor);
    if (parentPath === cursor) {
      break;
    }
    cursor = parentPath;
  }

  return ancestors;
}

function buildRootLabel(rootPath: string, profile: CodexProfileConfig): string {
  if (rootPath === profile.workspaceCwd) {
    return `${profile.label} Workspace`;
  }

  if (rootPath === profile.codexHome) {
    return `${profile.label} Home`;
  }

  if (rootPath === CODEX_APP_CONFIG.workspaceRoot) {
    return 'Workspace Root';
  }

  if (rootPath === '/tmp') {
    return '/tmp';
  }

  return path.basename(rootPath) || rootPath;
}

export async function getCodexFolderRoots(profileId?: string): Promise<CodexFolderRoot[]> {
  const profile = resolveProfile(profileId);
  const seen = new Set<string>();
  const resolvedRoots: CodexFolderRoot[] = [];
  const candidateRoots = new Set<string>([
    ...CODEX_APP_CONFIG.allowedFileRoots,
    ...listPathAncestors(profile.workspaceCwd),
    ...listPathAncestors(profile.codexHome),
  ]);

  for (const candidate of candidateRoots) {
    const realRoot = await realpathIfExists(candidate);
    if (!realRoot || seen.has(realRoot)) {
      continue;
    }

    const stats = await fs.stat(realRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      continue;
    }

    seen.add(realRoot);
    resolvedRoots.push({
      label: buildRootLabel(realRoot, profile),
      path: realRoot,
    });
  }

  resolvedRoots.sort((left, right) => left.path.localeCompare(right.path));
  return resolvedRoots;
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

export async function resolveCodexFolderPath(
  requestedPath: string | undefined,
  profileId?: string
): Promise<{
  profile: CodexProfileConfig;
  resolvedPath: string;
  rootPath: string;
  roots: CodexFolderRoot[];
}> {
  const profile = resolveProfile(profileId);
  const roots = await getCodexFolderRoots(profileId);
  const basePath = requestedPath?.trim()
    ? (path.isAbsolute(requestedPath) ? requestedPath.trim() : path.resolve(profile.workspaceCwd, requestedPath.trim()))
    : profile.workspaceCwd;
  const realPath = await realpathIfExists(basePath);

  if (!realPath) {
    const suggestion = await suggestNearbyDirectory(basePath);
    if (suggestion) {
      throw new Error(`Directory was not found. Did you mean: ${suggestion}?`);
    }

    throw new Error('Directory was not found');
  }

  const stats = await fs.stat(realPath).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error('Requested path is not a directory');
  }

  const root = findContainingRoot(realPath, roots);
  if (!root) {
    throw new Error('Directory is outside the allowed server roots');
  }

  return {
    profile,
    resolvedPath: realPath,
    rootPath: root.path,
    roots,
  };
}

export async function browseCodexFolders(
  requestedPath: string | undefined,
  profileId?: string
): Promise<CodexFolderBrowseResult> {
  const { resolvedPath, rootPath, roots } = await resolveCodexFolderPath(requestedPath, profileId);
  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  const folders: CodexFolderEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(resolvedPath, entry.name);
    const realEntryPath = await realpathIfExists(entryPath);
    if (!realEntryPath) {
      continue;
    }

    if (!findContainingRoot(realEntryPath, roots)) {
      continue;
    }

    folders.push({
      name: entry.name,
      path: realEntryPath,
      relativePath: path.relative(rootPath, realEntryPath) || entry.name,
      rootPath,
    });

    if (folders.length >= MAX_FOLDER_ENTRIES) {
      break;
    }
  }

  folders.sort((left, right) => left.name.localeCompare(right.name, 'he'));

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
    entries: folders,
    roots,
  };
}
