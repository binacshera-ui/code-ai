import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface CodexProjectAnchor {
  id: string;
  cwd: string;
  targetPath: string;
  targetKind: 'file' | 'directory';
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectAnchorsState {
  anchors: CodexProjectAnchor[];
}

const ANCHORS_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'project-anchors.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: ProjectAnchorsState = {
  anchors: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function cloneAnchor(anchor: CodexProjectAnchor): CodexProjectAnchor {
  return { ...anchor };
}

function normalizeText(value: string, fieldLabel: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error(`${fieldLabel} is required`);
  }

  return normalized.slice(0, limit);
}

function normalizeAbsolutePath(value: string, fieldLabel: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldLabel} is required`);
  }

  return path.resolve(normalized);
}

function ensurePathInsideCwd(cwd: string, targetPath: string) {
  const relative = path.relative(cwd, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Anchor target must stay inside the current folder');
  }
}

async function ensureStateLoaded() {
  if (stateLoadedPromise) {
    return stateLoadedPromise;
  }

  stateLoadedPromise = (async () => {
    try {
      const raw = await fs.readFile(ANCHORS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ProjectAnchorsState>;
      state = {
        anchors: Array.isArray(parsed.anchors)
          ? parsed.anchors
            .filter((anchor): anchor is CodexProjectAnchor => Boolean(
              anchor
              && typeof anchor.id === 'string'
              && typeof anchor.cwd === 'string'
              && typeof anchor.targetPath === 'string'
              && (anchor.targetKind === 'file' || anchor.targetKind === 'directory')
              && typeof anchor.name === 'string'
              && typeof anchor.description === 'string'
              && typeof anchor.createdAt === 'string'
              && typeof anchor.updatedAt === 'string'
            ))
            .map((anchor) => ({
              ...anchor,
              cwd: path.resolve(anchor.cwd),
              targetPath: path.resolve(anchor.targetPath),
            }))
          : [],
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      state = {
        anchors: [],
      };
    }
  })();

  return stateLoadedPromise;
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(ANCHORS_FILE), { recursive: true });
    await fs.writeFile(ANCHORS_FILE, snapshot, 'utf-8');
  });

  await persistTail;
}

export async function listProjectAnchors(cwd: string): Promise<CodexProjectAnchor[]> {
  await ensureStateLoaded();
  const normalizedCwd = path.resolve(cwd);
  return state.anchors
    .filter((anchor) => anchor.cwd === normalizedCwd)
    .sort((left, right) => left.name.localeCompare(right.name, 'he'))
    .map(cloneAnchor);
}

export async function createProjectAnchor(
  cwd: string,
  input: {
    targetPath: string;
    targetKind: 'file' | 'directory';
    name: string;
    description: string;
  }
): Promise<CodexProjectAnchor> {
  await ensureStateLoaded();

  const normalizedCwd = normalizeAbsolutePath(cwd, 'Anchor folder');
  const normalizedTargetPath = normalizeAbsolutePath(input.targetPath, 'Anchor target');
  ensurePathInsideCwd(normalizedCwd, normalizedTargetPath);

  const anchor: CodexProjectAnchor = {
    id: randomUUID(),
    cwd: normalizedCwd,
    targetPath: normalizedTargetPath,
    targetKind: input.targetKind,
    name: normalizeText(input.name, 'Anchor name', 80),
    description: normalizeText(input.description, 'Anchor description', 400),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  state.anchors.push(anchor);
  await persistState();
  return cloneAnchor(anchor);
}

export async function deleteProjectAnchor(cwd: string, anchorId: string): Promise<void> {
  await ensureStateLoaded();

  const normalizedCwd = path.resolve(cwd);
  const nextAnchors = state.anchors.filter((anchor) => !(anchor.id === anchorId && anchor.cwd === normalizedCwd));
  if (nextAnchors.length === state.anchors.length) {
    return;
  }

  state.anchors = nextAnchors;
  await persistState();
}
