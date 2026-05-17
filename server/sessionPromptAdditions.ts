import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';
import { listProjectAnchors } from './codexProjectAnchors.js';
import { getSessionContextSelection } from './codexSessionContextSelections.js';
import { getUnifiedSkillsByIds } from './skillCatalogService.js';

const CONTEXT_PACK_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'context-packs');

function sanitizeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

async function ensureContextPackRoot() {
  await fs.mkdir(CONTEXT_PACK_ROOT, { recursive: true });
}

function renderAnchorBlock(anchors: Awaited<ReturnType<typeof listProjectAnchors>>) {
  return anchors.map((anchor, index) => {
    const relativePath = path.relative(anchor.cwd, anchor.targetPath) || '.';
    return [
      `### עוגן ${index + 1}: ${anchor.name}`,
      `תיאור: ${anchor.description}`,
      `סוג: ${anchor.targetKind === 'directory' ? 'תיקייה' : 'קובץ'}`,
      `נתיב יחסי: ${relativePath}`,
      `נתיב מלא: ${anchor.targetPath}`,
    ].join('\n');
  }).join('\n\n');
}

function renderSkillBlock(skills: Awaited<ReturnType<typeof getUnifiedSkillsByIds>>) {
  return skills.map((skill, index) => (
    [
      `### סקיל ${index + 1}: ${skill.displayName}`,
      `מקור: ${skill.sourceLabel} (${skill.providerOrigin})`,
      `נתיב: ${skill.path}`,
      '',
      skill.content,
    ].join('\n')
  )).join('\n\n');
}

export async function buildSessionPromptAdditionsContext(options: {
  profileId: string;
  sessionKey: string;
  cwd: string | null;
}): Promise<string | null> {
  if (!options.cwd) {
    return null;
  }

  const selection = await getSessionContextSelection(options.profileId, options.sessionKey);
  if (selection.anchorIds.length === 0 && selection.skillIds.length === 0) {
    return null;
  }

  const [allAnchors, selectedSkills] = await Promise.all([
    listProjectAnchors(options.cwd),
    getUnifiedSkillsByIds(selection.skillIds),
  ]);
  const selectedAnchorIdSet = new Set(selection.anchorIds);
  const selectedAnchors = allAnchors.filter((anchor) => selectedAnchorIdSet.has(anchor.id));

  if (selectedAnchors.length === 0 && selectedSkills.length === 0) {
    return null;
  }

  const packSections = [
    '# Code-AI context pack',
    'הקובץ הזה נוצר על ידי Code-AI כדי לטעון לשיחה עוגנים וסקילים שנבחרו ידנית למהלך השיחה.',
  ];

  if (selectedAnchors.length > 0) {
    packSections.push('## עוגנים נבחרים', renderAnchorBlock(selectedAnchors));
  }

  if (selectedSkills.length > 0) {
    packSections.push('## סקילים נבחרים', renderSkillBlock(selectedSkills));
  }

  await ensureContextPackRoot();
  const profileDir = path.join(CONTEXT_PACK_ROOT, sanitizeFileToken(options.profileId));
  await fs.mkdir(profileDir, { recursive: true });
  const packPath = path.join(profileDir, `${sanitizeFileToken(options.sessionKey)}.md`);
  const packContent = `${packSections.join('\n\n')}\n`;
  await fs.writeFile(packPath, packContent, 'utf-8');

  const anchorsPreview = selectedAnchors.length > 0
    ? `עוגנים פעילים: ${selectedAnchors.map((anchor) => anchor.name).join(', ')}.`
    : null;
  const skillsPreview = selectedSkills.length > 0
    ? `סקילים פעילים: ${selectedSkills.map((skill) => skill.displayName).join(', ')}.`
    : null;

  return [
    'להלן context pack מחייב לשיחה הזו. הוא נשמר גם בקובץ מקומי לצורך מעקב, וגם מוזרק כאן ישירות כדי שלא תהיה תלות בפתיחת קבצים חיצוניים.',
    packPath,
    '--- BEGIN CONTEXT PACK ---',
    packContent.trim(),
    '--- END CONTEXT PACK ---',
    anchorsPreview,
    skillsPreview,
    'יש ליישם את כל המידע לעיל כהקשר מחייב לשיחה הזו, גם אם המשתמש לא חזר עליו שוב.',
  ].filter(Boolean).join('\n\n');
}
