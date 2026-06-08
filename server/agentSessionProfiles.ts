import { promises as fs } from 'fs';
import path from 'path';
import type { CodexProfile } from './codexService.js';
import { CODEX_APP_CONFIG } from './config.js';
import { alignPathOwnershipToProfile } from './providerRuntimeOwnership.js';

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyFileIfFresh(sourcePath: string, targetPath: string): Promise<void> {
  if (!await pathExists(sourcePath)) {
    return;
  }

  const sourceStat = await fs.stat(sourcePath);
  const targetStat = await fs.stat(targetPath).catch(() => null);
  if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs && targetStat.size === sourceStat.size) {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

function getProfileHomeRoot(profile: CodexProfile): string {
  return path.dirname(profile.codexHome);
}

function getSourceProfile(profile: CodexProfile): CodexProfile | null {
  if (!profile.sourceProfileId) {
    return null;
  }

  return CODEX_APP_CONFIG.profiles.find((candidate) => candidate.id === profile.sourceProfileId) || null;
}

export function isAgentSessionProfile(profile: Pick<CodexProfile, 'mode'> | null | undefined): boolean {
  return profile?.mode === 'agent';
}

export async function prepareAgentSessionProfileHome(profile: CodexProfile): Promise<void> {
  if (!isAgentSessionProfile(profile)) {
    return;
  }

  const sourceProfile = getSourceProfile(profile);
  if (!sourceProfile) {
    throw new Error(`Agent profile ${profile.id} is missing its source profile binding`);
  }

  await fs.mkdir(profile.codexHome, { recursive: true });
  await fs.mkdir(getProfileHomeRoot(profile), { recursive: true });

  if (profile.provider === 'claude') {
    await Promise.all([
      copyFileIfFresh(path.join(getProfileHomeRoot(sourceProfile), '.claude.json'), path.join(getProfileHomeRoot(profile), '.claude.json')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, '.credentials.json'), path.join(profile.codexHome, '.credentials.json')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, 'settings.json'), path.join(profile.codexHome, 'settings.json')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, 'mcp-needs-auth-cache.json'), path.join(profile.codexHome, 'mcp-needs-auth-cache.json')),
    ]);
    alignPathOwnershipToProfile(profile, getProfileHomeRoot(profile));
    return;
  }

  if (profile.provider === 'gemini') {
    await Promise.all([
      copyFileIfFresh(path.join(sourceProfile.codexHome, '.env'), path.join(profile.codexHome, '.env')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, 'oauth_creds.json'), path.join(profile.codexHome, 'oauth_creds.json')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, 'google_accounts.json'), path.join(profile.codexHome, 'google_accounts.json')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, 'projects.json'), path.join(profile.codexHome, 'projects.json')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, 'installation_id'), path.join(profile.codexHome, 'installation_id')),
    ]);
    alignPathOwnershipToProfile(profile, getProfileHomeRoot(profile));
    return;
  }

  await Promise.all([
    copyFileIfFresh(path.join(sourceProfile.codexHome, 'auth.json'), path.join(profile.codexHome, 'auth.json')),
    copyFileIfFresh(path.join(sourceProfile.codexHome, 'config.toml'), path.join(profile.codexHome, 'config.toml')),
  ]);
  alignPathOwnershipToProfile(profile, profile.codexHome);
}
