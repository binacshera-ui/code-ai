import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { CODEX_APP_CONFIG, type AppProvider } from './config.js';

export type SessionChangeFileStatus = 'created' | 'modified' | 'deleted' | 'renamed';

export interface SessionChangeFileRecord {
  id: string;
  path: string;
  displayPath: string;
  previousPath: string | null;
  status: SessionChangeFileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  diffText: string;
  diffTruncated: boolean;
}

export interface SessionChangeSummary {
  totalFiles: number;
  created: number;
  modified: number;
  deleted: number;
  renamed: number;
  additions: number;
  deletions: number;
}

export interface SessionChangeRecord {
  sessionId: string;
  entryId: string;
  provider: AppProvider;
  profileId: string;
  cwd: string | null;
  repoRoot: string | null;
  createdAt: string;
  summary: SessionChangeSummary;
  files: SessionChangeFileRecord[];
}

interface CaptureUntrackedFile {
  absolutePath: string;
  relativePath: string;
  snapshotPath: string;
}

interface SessionChangeCapture {
  captureId: string;
  provider: AppProvider;
  profileId: string;
  cwd: string;
  repoRoot: string | null;
  scopePath: string | null;
  trackedSnapshotRef: string | null;
  startedAt: string;
  tempRoot: string;
  startUntrackedFiles: CaptureUntrackedFile[];
}

interface FinalizeSessionChangeCaptureInput {
  sessionId: string;
  entryId: string | null;
}

interface TrackedFileDelta {
  path: string;
  previousPath: string | null;
  status: SessionChangeFileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

const SESSION_CHANGE_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'session-changes');
const SESSION_CHANGE_TEMP_ROOT = path.join(SESSION_CHANGE_ROOT, '.tmp');
const MAX_DIFF_TEXT_LENGTH = 200_000;

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function buildSessionChangeRecordPath(sessionId: string, entryId: string) {
  return path.join(
    SESSION_CHANGE_ROOT,
    sanitizeFileToken(sessionId),
    `${sanitizeFileToken(entryId)}.json`,
  );
}

function clipDiffText(rawText: string): { text: string; truncated: boolean } {
  if (rawText.length <= MAX_DIFF_TEXT_LENGTH) {
    return {
      text: rawText,
      truncated: false,
    };
  }

  return {
    text: `${rawText.slice(0, MAX_DIFF_TEXT_LENGTH).trimEnd()}\n\n... diff truncated ...`,
    truncated: true,
  };
}

function computeDisplayPath(filePath: string, cwd: string, repoRoot: string | null): string {
  if (!repoRoot) {
    return filePath;
  }

  const absolutePath = path.resolve(repoRoot, filePath);
  const relativeToCwd = path.relative(cwd, absolutePath);
  if (relativeToCwd && !relativeToCwd.startsWith('..') && !path.isAbsolute(relativeToCwd)) {
    return relativeToCwd;
  }

  return filePath;
}

function normalizeScopePath(repoRoot: string, cwd: string): string | null {
  const relative = path.relative(repoRoot, cwd);
  if (!relative || relative === '.') {
    return null;
  }

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return relative.split(path.sep).join('/');
}

function runGit(
  repoRoot: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    cwd?: string;
    encoding?: BufferEncoding;
  } = {}
) {
  const result = spawnSync('git', args, {
    cwd: options.cwd || repoRoot,
    encoding: options.encoding || 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error && !options.allowFailure) {
    throw result.error;
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout || '');
  const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr || '');

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(' ')} failed`);
  }

  return {
    status: result.status ?? 0,
    stdout,
    stderr,
  };
}

function resolveGitRepoRoot(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  if (result.status !== 0) {
    return null;
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  return stdout ? path.resolve(stdout) : null;
}

function resolveTrackedSnapshotRef(repoRoot: string): string | null {
  const stashRef = runGit(repoRoot, ['stash', 'create', 'code-ai session change snapshot'], {
    allowFailure: true,
  }).stdout.trim();

  if (stashRef) {
    return stashRef;
  }

  const headRef = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
    allowFailure: true,
  }).stdout.trim();

  return headRef || null;
}

function buildTrackedScopeArgs(scopePath: string | null): string[] {
  if (!scopePath) {
    return [];
  }

  return ['--', scopePath];
}

function parseNumstatLines(rawText: string): Map<string, { additions: number; deletions: number; isBinary: boolean }> {
  const map = new Map<string, { additions: number; deletions: number; isBinary: boolean }>();
  const lines = rawText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) {
      continue;
    }

    const additionsToken = parts[0];
    const deletionsToken = parts[1];
    const filePath = parts.length >= 4 ? parts[parts.length - 1] : parts[2];
    const additions = Number.parseInt(additionsToken, 10);
    const deletions = Number.parseInt(deletionsToken, 10);
    map.set(filePath, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      isBinary: additionsToken === '-' || deletionsToken === '-',
    });
  }

  return map;
}

function parseTrackedDeltas(
  repoRoot: string,
  startRef: string | null,
  endRef: string | null,
  scopePath: string | null
): TrackedFileDelta[] {
  if (!startRef || !endRef) {
    return [];
  }

  const scopeArgs = buildTrackedScopeArgs(scopePath);
  const statusOutput = runGit(repoRoot, ['diff', '--find-renames', '--name-status', startRef, endRef, ...scopeArgs], {
    allowFailure: true,
  }).stdout;
  const numstatOutput = runGit(repoRoot, ['diff', '--find-renames', '--numstat', startRef, endRef, ...scopeArgs], {
    allowFailure: true,
  }).stdout;
  const numstatMap = parseNumstatLines(numstatOutput);
  const deltas: TrackedFileDelta[] = [];

  for (const rawLine of statusOutput.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }

    const parts = line.split('\t');
    if (parts.length < 2) {
      continue;
    }

    const code = parts[0];
    const primaryCode = code.charAt(0);
    const previousPath = primaryCode === 'R' || primaryCode === 'C' ? parts[1] || null : null;
    const currentPath = primaryCode === 'R' || primaryCode === 'C'
      ? parts[2] || parts[1]
      : parts[1];

    if (!currentPath) {
      continue;
    }

    const counts = numstatMap.get(currentPath)
      || (previousPath ? numstatMap.get(previousPath) : undefined)
      || { additions: 0, deletions: 0, isBinary: false };

    let status: SessionChangeFileStatus = 'modified';
    if (primaryCode === 'A' || primaryCode === 'C') {
      status = 'created';
    } else if (primaryCode === 'D') {
      status = 'deleted';
    } else if (primaryCode === 'R') {
      status = 'renamed';
    }

    deltas.push({
      path: currentPath,
      previousPath,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      isBinary: counts.isBinary,
    });
  }

  return deltas;
}

function countDiffLines(diffText: string) {
  let additions = 0;
  let deletions = 0;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }

    if (line.startsWith('+')) {
      additions += 1;
      continue;
    }

    if (line.startsWith('-')) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function buildTrackedDiffText(
  repoRoot: string,
  startRef: string | null,
  endRef: string | null,
  delta: TrackedFileDelta
): { diffText: string; diffTruncated: boolean } {
  if (!startRef || !endRef) {
    return { diffText: '', diffTruncated: false };
  }

  const pathArgs = delta.previousPath && delta.previousPath !== delta.path
    ? ['--', delta.previousPath, delta.path]
    : ['--', delta.status === 'deleted' ? (delta.previousPath || delta.path) : delta.path];
  const diffOutput = runGit(
    repoRoot,
    ['diff', '--find-renames', '--unified=3', startRef, endRef, ...pathArgs],
    { allowFailure: true }
  ).stdout.trim();

  return clipDiffText(diffOutput);
}

async function listUntrackedFiles(
  repoRoot: string,
  scopePath: string | null
): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const stdout = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '--full-name'], {
    allowFailure: true,
  }).stdout;

  const scopedPrefix = scopePath ? `${scopePath.replace(/\\/g, '/')}/` : null;

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((relativePath) => {
      if (!scopePath) {
        return true;
      }
      return relativePath === scopePath || relativePath.startsWith(scopedPrefix || '');
    })
    .map((relativePath) => ({
      relativePath,
      absolutePath: path.join(repoRoot, relativePath),
    }));
}

async function snapshotUntrackedFiles(
  tempRoot: string,
  files: Array<{ absolutePath: string; relativePath: string }>
): Promise<CaptureUntrackedFile[]> {
  const snapshotDir = path.join(tempRoot, 'untracked-start');
  const captured: CaptureUntrackedFile[] = [];

  await fs.mkdir(snapshotDir, { recursive: true });

  for (const file of files) {
    const destinationPath = path.join(snapshotDir, file.relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(file.absolutePath, destinationPath);
    captured.push({
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      snapshotPath: destinationPath,
    });
  }

  return captured;
}

function isBinaryDiffText(diffText: string): boolean {
  return /Binary files .* differ/.test(diffText);
}

function buildNoIndexDiff(
  leftPath: string | null,
  rightPath: string | null
): { diffText: string; diffTruncated: boolean; isBinary: boolean; additions: number; deletions: number } {
  const effectiveLeft = leftPath || '/dev/null';
  const effectiveRight = rightPath || '/dev/null';
  const result = spawnSync(
    'git',
    ['diff', '--no-index', '--unified=3', '--', effectiveLeft, effectiveRight],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const diffText = typeof result.stdout === 'string'
    ? result.stdout.trim()
    : String(result.stdout || '').trim();
  const clipped = clipDiffText(diffText);
  const binary = isBinaryDiffText(diffText);
  const counts = binary ? { additions: 0, deletions: 0 } : countDiffLines(diffText);

  return {
    diffText: clipped.text,
    diffTruncated: clipped.truncated,
    isBinary: binary,
    additions: counts.additions,
    deletions: counts.deletions,
  };
}

function buildSummary(files: SessionChangeFileRecord[]): SessionChangeSummary {
  return files.reduce<SessionChangeSummary>((summary, file) => {
    summary.totalFiles += 1;
    summary.additions += file.additions;
    summary.deletions += file.deletions;
    summary[file.status] += 1;
    return summary;
  }, {
    totalFiles: 0,
    created: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    additions: 0,
    deletions: 0,
  });
}

export async function beginSessionChangeCapture(input: {
  provider: AppProvider;
  profileId: string;
  cwd: string;
}): Promise<SessionChangeCapture | null> {
  const normalizedCwd = path.resolve(input.cwd);
  const repoRoot = resolveGitRepoRoot(normalizedCwd);
  if (!repoRoot) {
    return null;
  }

  const scopePath = normalizeScopePath(repoRoot, normalizedCwd);
  const tempRoot = path.join(SESSION_CHANGE_TEMP_ROOT, randomUUID());
  await fs.mkdir(tempRoot, { recursive: true });
  const startUntrackedFiles = await snapshotUntrackedFiles(
    tempRoot,
    await listUntrackedFiles(repoRoot, scopePath),
  );

  return {
    captureId: randomUUID(),
    provider: input.provider,
    profileId: input.profileId,
    cwd: normalizedCwd,
    repoRoot,
    scopePath,
    trackedSnapshotRef: resolveTrackedSnapshotRef(repoRoot),
    startedAt: nowIso(),
    tempRoot,
    startUntrackedFiles,
  };
}

export async function finalizeSessionChangeCapture(
  capture: SessionChangeCapture | null,
  input: FinalizeSessionChangeCaptureInput
): Promise<SessionChangeRecord | null> {
  if (!capture || !input.entryId) {
    return null;
  }

  try {
    const files: SessionChangeFileRecord[] = [];
    const endTrackedSnapshotRef = capture.repoRoot
      ? resolveTrackedSnapshotRef(capture.repoRoot)
      : null;

    if (capture.repoRoot) {
      const trackedDeltas = parseTrackedDeltas(
        capture.repoRoot,
        capture.trackedSnapshotRef,
        endTrackedSnapshotRef,
        capture.scopePath,
      );

      for (const delta of trackedDeltas) {
        const diff = buildTrackedDiffText(capture.repoRoot, capture.trackedSnapshotRef, endTrackedSnapshotRef, delta);
        files.push({
          id: `${delta.previousPath || delta.path}:${delta.status}`,
          path: delta.path,
          displayPath: computeDisplayPath(delta.path, capture.cwd, capture.repoRoot),
          previousPath: delta.previousPath,
          status: delta.status,
          additions: delta.additions,
          deletions: delta.deletions,
          isBinary: delta.isBinary,
          diffText: diff.diffText,
          diffTruncated: diff.diffTruncated,
        });
      }

      const startUntrackedMap = new Map(capture.startUntrackedFiles.map((file) => [file.relativePath, file]));
      const endUntrackedFiles = await listUntrackedFiles(capture.repoRoot, capture.scopePath);
      const endUntrackedMap = new Map(endUntrackedFiles.map((file) => [file.relativePath, file]));

      const allUntrackedPaths = new Set([
        ...startUntrackedMap.keys(),
        ...endUntrackedMap.keys(),
      ]);

      for (const relativePath of allUntrackedPaths) {
        const startFile = startUntrackedMap.get(relativePath) || null;
        const endFile = endUntrackedMap.get(relativePath) || null;

        if (startFile && endFile) {
          const diff = buildNoIndexDiff(startFile.snapshotPath, endFile.absolutePath);
          if (!diff.diffText) {
            continue;
          }
          files.push({
            id: `${relativePath}:modified-untracked`,
            path: relativePath,
            displayPath: computeDisplayPath(relativePath, capture.cwd, capture.repoRoot),
            previousPath: null,
            status: 'modified',
            additions: diff.additions,
            deletions: diff.deletions,
            isBinary: diff.isBinary,
            diffText: diff.diffText,
            diffTruncated: diff.diffTruncated,
          });
          continue;
        }

        if (!startFile && endFile) {
          const diff = buildNoIndexDiff(null, endFile.absolutePath);
          files.push({
            id: `${relativePath}:created-untracked`,
            path: relativePath,
            displayPath: computeDisplayPath(relativePath, capture.cwd, capture.repoRoot),
            previousPath: null,
            status: 'created',
            additions: diff.additions,
            deletions: diff.deletions,
            isBinary: diff.isBinary,
            diffText: diff.diffText,
            diffTruncated: diff.diffTruncated,
          });
          continue;
        }

        if (startFile && !endFile) {
          const diff = buildNoIndexDiff(startFile.snapshotPath, null);
          files.push({
            id: `${relativePath}:deleted-untracked`,
            path: relativePath,
            displayPath: computeDisplayPath(relativePath, capture.cwd, capture.repoRoot),
            previousPath: null,
            status: 'deleted',
            additions: diff.additions,
            deletions: diff.deletions,
            isBinary: diff.isBinary,
            diffText: diff.diffText,
            diffTruncated: diff.diffTruncated,
          });
        }
      }
    }

    const uniqueFiles = files.reduce<Map<string, SessionChangeFileRecord>>((map, file) => {
      map.set(`${file.status}:${file.path}:${file.previousPath || ''}`, file);
      return map;
    }, new Map());
    const orderedFiles = [...uniqueFiles.values()].sort((left, right) => left.displayPath.localeCompare(right.displayPath));

    const record: SessionChangeRecord = {
      sessionId: input.sessionId,
      entryId: input.entryId,
      provider: capture.provider,
      profileId: capture.profileId,
      cwd: capture.cwd,
      repoRoot: capture.repoRoot,
      createdAt: nowIso(),
      summary: buildSummary(orderedFiles),
      files: orderedFiles,
    };

    const targetPath = buildSessionChangeRecordPath(input.sessionId, input.entryId);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, JSON.stringify(record, null, 2), 'utf8');

    return record;
  } finally {
    await fs.rm(capture?.tempRoot || SESSION_CHANGE_TEMP_ROOT, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function discardSessionChangeCapture(capture: SessionChangeCapture | null): Promise<void> {
  if (!capture) {
    return;
  }

  await fs.rm(capture.tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

export async function readSessionChangeRecord(
  sessionId: string,
  entryId: string
): Promise<SessionChangeRecord | null> {
  try {
    const raw = await fs.readFile(buildSessionChangeRecordPath(sessionId, entryId), 'utf8');
    return JSON.parse(raw) as SessionChangeRecord;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
