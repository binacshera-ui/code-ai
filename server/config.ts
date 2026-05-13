import { existsSync } from 'fs';
import path from 'path';

export type AppProvider = 'codex' | 'claude' | 'gemini';
export type AppMode = 'standard' | 'support';

export interface CodexProfileConfig {
  id: string;
  label: string;
  provider: AppProvider;
  mode?: AppMode;
  codexHome: string;
  workspaceCwd: string;
  sourceProfileId?: string;
  sandboxCwd?: string;
  defaultProfile?: boolean;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function listAncestorPaths(targetPath: string): string[] {
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

function normalizeProfile(profile: Partial<CodexProfileConfig>): CodexProfileConfig | null {
  const provider = profile.provider || 'codex';
  const mode = profile.mode || 'standard';

  if (
    !profile.id
    || !profile.label
    || !profile.codexHome
    || !profile.workspaceCwd
  ) {
    return null;
  }

  return {
    id: profile.id,
    label: profile.label,
    provider,
    mode,
    codexHome: path.resolve(profile.codexHome),
    workspaceCwd: path.resolve(profile.workspaceCwd),
    sourceProfileId: typeof profile.sourceProfileId === 'string' && profile.sourceProfileId.trim()
      ? profile.sourceProfileId.trim()
      : undefined,
    sandboxCwd: typeof profile.sandboxCwd === 'string' && profile.sandboxCwd.trim()
      ? path.resolve(profile.sandboxCwd)
      : undefined,
    defaultProfile: Boolean(profile.defaultProfile),
  };
}

function inferWorkspaceRoot(appRoot: string): string {
  const candidates = [
    appRoot,
    path.resolve(appRoot, '..'),
    path.resolve(appRoot, '../..'),
    path.resolve(appRoot, '../../..'),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, '.git'))) {
      return candidate;
    }
  }

  if (path.basename(appRoot) === 'app' && path.basename(path.resolve(appRoot, '..')) === 'web') {
    return path.resolve(appRoot, '../..');
  }

  return appRoot;
}

function getDefaultProfiles(appRoot: string): CodexProfileConfig[] {
  const workspaceRoot = inferWorkspaceRoot(appRoot);

  return [
    {
      id: 'developer',
      label: 'Developer',
      provider: 'codex',
      mode: 'standard',
      codexHome: '/home/developer/.codex',
      workspaceCwd: workspaceRoot,
      defaultProfile: true,
    },
    {
      id: 'developer2',
      label: 'Developer 2',
      provider: 'codex',
      mode: 'standard',
      codexHome: '/home/developer2/.codex',
      workspaceCwd: workspaceRoot,
    },
    {
      id: 'claude-developer',
      label: 'Developer',
      provider: 'claude',
      mode: 'standard',
      codexHome: '/home/developer/.claude',
      workspaceCwd: workspaceRoot,
    },
    {
      id: 'claude-developer2',
      label: 'Developer 2',
      provider: 'claude',
      mode: 'standard',
      codexHome: '/home/developer2/.claude',
      workspaceCwd: workspaceRoot,
    },
    {
      id: 'gemini-developer',
      label: 'Developer',
      provider: 'gemini',
      mode: 'standard',
      codexHome: '/home/developer/.gemini',
      workspaceCwd: workspaceRoot,
    },
    {
      id: 'gemini-developer2',
      label: 'Developer 2',
      provider: 'gemini',
      mode: 'standard',
      codexHome: '/home/developer2/.gemini',
      workspaceCwd: workspaceRoot,
    },
  ];
}

function buildDerivedSupportProfiles(baseProfiles: CodexProfileConfig[], appRoot: string): CodexProfileConfig[] {
  const storageRoot = path.resolve(process.env.CODEX_STORAGE_ROOT || path.join(appRoot, '.code-ai'));
  const supportRoot = path.join(storageRoot, 'support');
  const derivedProfiles: CodexProfileConfig[] = [];

  for (const profile of baseProfiles) {
    if (profile.mode === 'support') {
      continue;
    }

    const supportProfileId = `support-${profile.id}`;
    if (baseProfiles.some((candidate) => candidate.id === supportProfileId)) {
      continue;
    }

    const supportHomeBase = path.join(supportRoot, 'homes', profile.provider, profile.id);
    const supportProviderHome = profile.provider === 'claude'
      ? path.join(supportHomeBase, '.claude')
      : profile.provider === 'gemini'
        ? path.join(supportHomeBase, '.gemini')
        : supportHomeBase;

    derivedProfiles.push({
      id: supportProfileId,
      label: profile.label,
      provider: profile.provider,
      mode: 'support',
      sourceProfileId: profile.id,
      codexHome: supportProviderHome,
      workspaceCwd: profile.workspaceCwd,
      sandboxCwd: path.join(supportRoot, 'sandbox', profile.provider, profile.id),
      defaultProfile: Boolean(profile.defaultProfile),
    });
  }

  return derivedProfiles;
}

function loadProfiles(appRoot: string): CodexProfileConfig[] {
  const raw = process.env.CODEX_PROFILES_JSON?.trim();
  const finalizeProfiles = (baseProfiles: CodexProfileConfig[]): CodexProfileConfig[] => {
    const profiles = [
      ...baseProfiles,
      ...buildDerivedSupportProfiles(baseProfiles, appRoot),
    ];

    const standardProfiles = profiles.filter((profile) => profile.mode !== 'support');
    if (!standardProfiles.some((profile) => profile.defaultProfile) && standardProfiles[0]) {
      standardProfiles[0].defaultProfile = true;
    }

    const supportProfiles = profiles.filter((profile) => profile.mode === 'support');
    if (!supportProfiles.some((profile) => profile.defaultProfile) && supportProfiles[0]) {
      supportProfiles[0].defaultProfile = true;
    }

    return profiles;
  };

  if (!raw) {
    return finalizeProfiles(getDefaultProfiles(appRoot));
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('CODEX_PROFILES_JSON must be a JSON array');
    }

    const profiles = parsed
      .map((entry) => normalizeProfile(entry))
      .filter((entry): entry is CodexProfileConfig => Boolean(entry));

    if (profiles.length === 0) {
      throw new Error('CODEX_PROFILES_JSON produced no valid profiles');
    }

    return finalizeProfiles(profiles);
  } catch (error: any) {
    throw new Error(`Failed to parse CODEX_PROFILES_JSON: ${error.message}`);
  }
}

const APP_ROOT = path.resolve(process.env.CODEX_APP_ROOT || process.cwd());
const WORKSPACE_ROOT = path.resolve(process.env.CODEX_WORKSPACE_ROOT || path.join(APP_ROOT, '..', '..'));
const STORAGE_ROOT = path.resolve(process.env.CODEX_STORAGE_ROOT || path.join(APP_ROOT, '.code-ai'));
const PROFILES = loadProfiles(APP_ROOT);
const ALLOW_ANY_PATHS = parseBoolean(process.env.CODEX_ALLOW_ANY_PATHS, true);

function buildBaseAllowedRoots(): string[] {
  const configuredRoots = parseCsv(process.env.CODEX_ALLOWED_FILE_ROOTS)
    .map((entry) => path.resolve(entry));
  const roots = new Set<string>([
    APP_ROOT,
    WORKSPACE_ROOT,
    STORAGE_ROOT,
    '/tmp',
    ...configuredRoots,
    ...PROFILES.flatMap((profile) => [profile.codexHome, profile.workspaceCwd]),
  ]);

  return [...roots];
}

function buildAllowedRoots(baseRoots: string[], allowAnyPaths: boolean): string[] {
  if (!allowAnyPaths) {
    return baseRoots;
  }

  const roots = new Set<string>(baseRoots);
  const ancestorSeeds = [
    APP_ROOT,
    WORKSPACE_ROOT,
    STORAGE_ROOT,
    ...PROFILES.flatMap((profile) => [profile.codexHome, profile.workspaceCwd]),
  ];

  for (const seedPath of ancestorSeeds) {
    for (const ancestorPath of listAncestorPaths(seedPath)) {
      roots.add(ancestorPath);
    }
  }

  return [...roots];
}

const BASE_ALLOWED_FILE_ROOTS = buildBaseAllowedRoots();
const ALLOWED_FILE_ROOTS = buildAllowedRoots(BASE_ALLOWED_FILE_ROOTS, ALLOW_ANY_PATHS);

export const CODEX_APP_CONFIG = {
  appRoot: APP_ROOT,
  workspaceRoot: WORKSPACE_ROOT,
  storageRoot: STORAGE_ROOT,
  uploadRoot: path.resolve(process.env.CODEX_UPLOAD_ROOT || path.join(STORAGE_ROOT, 'uploads')),
  queueRoot: path.resolve(process.env.CODEX_QUEUE_ROOT || path.join(STORAGE_ROOT, 'queue')),
  logRoot: path.resolve(process.env.CODEX_LOG_ROOT || path.join(STORAGE_ROOT, 'logs')),
  publicHosts: parseCsv(process.env.CODEX_PUBLIC_HOSTS),
  openAccess: parseBoolean(process.env.CODEX_OPEN_ACCESS, true),
  profiles: PROFILES,
  defaultProfileId: PROFILES.find((profile) => profile.defaultProfile)?.id || PROFILES[0]?.id || 'default',
  allowAnyPaths: ALLOW_ANY_PATHS,
  allowedFileRoots: ALLOWED_FILE_ROOTS,
  searchableFileRoots: BASE_ALLOWED_FILE_ROOTS,
  deviceAdminPassword: process.env.CODEX_DEVICE_ADMIN_PASSWORD || '403005Ashim@',
  sessionSecret: process.env.SESSION_SECRET || 'code-ai-session-secret',
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  sessionCookieDomain: process.env.SESSION_COOKIE_DOMAIN?.trim() || '',
};
