import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface UnifiedSkillSummary {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  providerOrigin: 'codex' | 'claude';
  scope: 'system' | 'project' | 'user' | 'plugin';
  sourceLabel: string;
  path: string;
}

interface UnifiedSkillRecord extends UnifiedSkillSummary {
  content: string;
}

interface SkillRootCandidate {
  root: string;
  providerOrigin: 'codex' | 'claude';
  scope: 'system' | 'project' | 'user' | 'plugin';
  sourceLabel: string;
}

const CACHE_TTL_MS = 20_000;

let skillCatalogCache:
  | {
      expiresAt: number;
      records: UnifiedSkillRecord[];
    }
  | null = null;

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectSkillFiles(root: string): Promise<string[]> {
  if (!await pathExists(root)) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSkillFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name === 'SKILL.md') {
      files.push(entryPath);
    }
  }

  return files;
}

function normalizeDescription(rawContent: string): string | null {
  const lines = rawContent
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  const firstLine = lines[0];
  if (!firstLine) {
    return null;
  }

  return firstLine.slice(0, 180);
}

function inferDisplayName(skillPath: string, rawContent: string): string {
  const heading = rawContent
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '));

  if (heading) {
    return heading.replace(/^#\s+/, '').trim();
  }

  return path.basename(path.dirname(skillPath))
    .replace(/[-_]+/g, ' ')
    .trim();
}

function buildSkillRootCandidates(): SkillRootCandidate[] {
  const candidates = new Map<string, SkillRootCandidate>();
  const pushCandidate = (candidate: SkillRootCandidate) => {
    candidates.set(`${candidate.providerOrigin}:${candidate.scope}:${candidate.root}`, candidate);
  };

  pushCandidate({
    root: path.join(CODEX_APP_CONFIG.workspaceRoot, '.codex', 'skills'),
    providerOrigin: 'codex',
    scope: 'project',
    sourceLabel: 'Codex Project',
  });

  for (const profile of CODEX_APP_CONFIG.profiles) {
    if (profile.provider === 'codex') {
      pushCandidate({
        root: path.join(profile.codexHome, 'skills'),
        providerOrigin: 'codex',
        scope: 'user',
        sourceLabel: 'Codex User',
      });
      continue;
    }

    if (profile.provider === 'claude') {
      pushCandidate({
        root: path.join(profile.codexHome, 'skills'),
        providerOrigin: 'claude',
        scope: 'user',
        sourceLabel: 'Claude User',
      });

      const pluginRoot = path.join(profile.codexHome, 'remote', 'plugins');
      candidates.set(`claude:plugin-root:${pluginRoot}`, {
        root: pluginRoot,
        providerOrigin: 'claude',
        scope: 'plugin',
        sourceLabel: 'Claude Plugin',
      });
    }
  }

  return [...candidates.values()];
}

async function collectClaudePluginSkillRoots(root: string): Promise<SkillRootCandidate[]> {
  if (!await pathExists(root)) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      root: path.join(root, entry.name, 'skills'),
      providerOrigin: 'claude' as const,
      scope: 'plugin' as const,
      sourceLabel: 'Claude Plugin',
    }));
}

async function loadSkillCatalogRecords(): Promise<UnifiedSkillRecord[]> {
  if (skillCatalogCache && skillCatalogCache.expiresAt > Date.now()) {
    return skillCatalogCache.records.map((record) => ({ ...record }));
  }

  const baseCandidates = buildSkillRootCandidates();
  const expandedCandidates: SkillRootCandidate[] = [];

  for (const candidate of baseCandidates) {
    if (candidate.scope === 'plugin' && candidate.root.endsWith(path.join('remote', 'plugins'))) {
      expandedCandidates.push(...await collectClaudePluginSkillRoots(candidate.root));
      continue;
    }

    expandedCandidates.push(candidate);
  }

  const deduped = new Map<string, UnifiedSkillRecord>();

  for (const candidate of expandedCandidates) {
    const skillFiles = await collectSkillFiles(candidate.root);
    for (const skillPath of skillFiles) {
      const rawContent = await fs.readFile(skillPath, 'utf-8');
      const normalizedContent = rawContent.trim();
      if (!normalizedContent) {
        continue;
      }

      const name = path.basename(path.dirname(skillPath));
      const displayName = inferDisplayName(skillPath, normalizedContent) || name;
      const signature = createHash('sha1')
        .update(`${candidate.providerOrigin}\n${name}\n${normalizedContent}`)
        .digest('hex');

      if (deduped.has(signature)) {
        continue;
      }

      deduped.set(signature, {
        id: signature,
        name,
        displayName,
        description: normalizeDescription(normalizedContent),
        providerOrigin: candidate.providerOrigin,
        scope: candidate.scope,
        sourceLabel: candidate.sourceLabel,
        path: skillPath,
        content: normalizedContent,
      });
    }
  }

  const records = [...deduped.values()].sort((left, right) => (
    left.displayName.localeCompare(right.displayName, 'he')
  ));

  skillCatalogCache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    records,
  };

  return records.map((record) => ({ ...record }));
}

export async function listUnifiedSkills(): Promise<UnifiedSkillSummary[]> {
  const records = await loadSkillCatalogRecords();
  return records.map(({ content: _content, ...record }) => ({ ...record }));
}

export async function getUnifiedSkillsByIds(skillIds: string[]): Promise<UnifiedSkillRecord[]> {
  if (!Array.isArray(skillIds) || skillIds.length === 0) {
    return [];
  }

  const wanted = new Set(skillIds.map((skillId) => skillId.trim()).filter(Boolean));
  const records = await loadSkillCatalogRecords();
  return records.filter((record) => wanted.has(record.id));
}
