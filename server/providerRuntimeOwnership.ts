import { existsSync, statSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { CODEX_APP_CONFIG, type CodexProfileConfig } from './config.js';

type ProviderRuntimeProfile = Pick<
  CodexProfileConfig,
  'id' | 'label' | 'provider' | 'mode' | 'codexHome' | 'workspaceCwd'
>;

interface ProfileOwnerIdentity {
  uid: number;
  gid: number;
  sourcePath: string;
}

const ownershipRepairCache = new Map<string, number>();
const OWNERSHIP_REPAIR_TTL_MS = 5 * 60 * 1000;

function listOwnershipSeeds(profile: ProviderRuntimeProfile): string[] {
  const seeds = [
    profile.codexHome,
    profile.workspaceCwd,
    CODEX_APP_CONFIG.storageRoot,
    path.dirname(profile.codexHome),
  ];

  return Array.from(new Set(seeds.map((value) => path.resolve(value))));
}

function findNearestExistingPath(targetPath: string): string | null {
  let cursor = path.resolve(targetPath);

  while (true) {
    if (existsSync(cursor)) {
      return cursor;
    }

    const parentPath = path.dirname(cursor);
    if (parentPath === cursor) {
      return null;
    }
    cursor = parentPath;
  }
}

function resolveOwnerIdentity(profile: ProviderRuntimeProfile): ProfileOwnerIdentity | null {
  const candidates = listOwnershipSeeds(profile)
    .map((seedPath) => findNearestExistingPath(seedPath))
    .filter((value): value is string => Boolean(value))
    .map((existingPath) => {
      const stats = statSync(existingPath);
      return {
        uid: stats.uid,
        gid: stats.gid,
        sourcePath: existingPath,
      };
    });

  if (!candidates.length) {
    return null;
  }

  const firstNonRootOwner = candidates.find((candidate) => candidate.uid !== 0);
  if (firstNonRootOwner) {
    return firstNonRootOwner;
  }

  const firstNonRootGroup = candidates.find((candidate) => candidate.gid !== 0);
  if (firstNonRootGroup) {
    return firstNonRootGroup;
  }

  return candidates[0];
}

function pathExists(targetPath: string): boolean {
  try {
    return existsSync(targetPath);
  } catch {
    return false;
  }
}

function listRepairTargets(profile: ProviderRuntimeProfile): string[] {
  const profileHomeRoot = path.dirname(profile.codexHome);
  const targets = new Set<string>([profile.codexHome]);

  if (profile.provider === 'claude') {
    targets.add(path.join(profileHomeRoot, '.claude.json'));
    targets.add(path.join(profileHomeRoot, '.cache', 'claude-cli-nodejs'));
  }

  if (profile.mode && profile.mode !== 'standard') {
    targets.add(profileHomeRoot);
  }

  return [...targets]
    .map((value) => path.resolve(value))
    .filter((value) => pathExists(value));
}

function recursivelyChown(targetPath: string, uid: number, gid: number): void {
  const args = ['-R', `${uid}:${gid}`, targetPath];
  const result = spawnSync('chown', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });

  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(detail || `chown failed for ${targetPath}`);
  }
}

export function ensureProfileRuntimeOwnership(profile: ProviderRuntimeProfile): ProfileOwnerIdentity | null {
  const identity = resolveOwnerIdentity(profile);
  if (!identity) {
    return null;
  }

  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return identity;
  }

  if (identity.uid === 0 && identity.gid === 0) {
    return identity;
  }

  const cacheKey = `${profile.id}:${identity.uid}:${identity.gid}`;
  const lastRepairAt = ownershipRepairCache.get(cacheKey) || 0;
  if (Date.now() - lastRepairAt < OWNERSHIP_REPAIR_TTL_MS) {
    return identity;
  }

  for (const targetPath of listRepairTargets(profile)) {
    recursivelyChown(targetPath, identity.uid, identity.gid);
  }

  ownershipRepairCache.set(cacheKey, Date.now());
  return identity;
}

export function getProfileSpawnIdentity(profile: ProviderRuntimeProfile): {
  uid?: number;
  gid?: number;
} {
  const identity = ensureProfileRuntimeOwnership(profile);
  if (!identity) {
    return {};
  }

  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return {};
  }

  if (identity.uid === 0 && identity.gid === 0) {
    return {};
  }

  return {
    uid: identity.uid,
    gid: identity.gid,
  };
}

export function alignPathOwnershipToProfile(profile: ProviderRuntimeProfile, targetPath: string): void {
  if (!targetPath || !pathExists(targetPath)) {
    return;
  }

  const identity = resolveOwnerIdentity(profile);
  if (!identity) {
    return;
  }

  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return;
  }

  if (identity.uid === 0 && identity.gid === 0) {
    return;
  }

  recursivelyChown(path.resolve(targetPath), identity.uid, identity.gid);
}

export function repairAllProviderHomesOwnership(profiles: ProviderRuntimeProfile[]): void {
  for (const profile of profiles) {
    try {
      ensureProfileRuntimeOwnership(profile);
    } catch (error: any) {
      console.warn(
        `Failed to repair runtime ownership for ${profile.id} (${profile.codexHome}): ${error?.message || 'unknown error'}`
      );
    }
  }
}
