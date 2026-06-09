import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';
import { listProjectAnchors } from './codexProjectAnchors.js';
import { getSessionContextSelection } from './codexSessionContextSelections.js';
import { getSessionRemindersByIds } from './codexSessionReminders.js';
import { getUnifiedSkillsByIds } from './skillCatalogService.js';

const CONTEXT_PACK_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'context-packs');

function sanitizeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

async function ensureContextPackRoot() {
  await fs.mkdir(CONTEXT_PACK_ROOT, { recursive: true });
}

function renderAnchorBlock(anchors: Awaited<ReturnType<typeof listProjectAnchors>>) {
  return anchors.map((anchor) => {
    const relativePath = path.relative(anchor.cwd, anchor.targetPath) || '.';
    return [
      'מצורף עוגן להבנה:',
      `שם העוגן: ${anchor.name}`,
      `מיקום העוגן: ${relativePath} (${anchor.targetPath})`,
      `תיאור העוגן לצורך ההבנה: ${anchor.description}`,
    ].join('\n');
  }).join('\n\n');
}

function renderSkillBlock(skills: Awaited<ReturnType<typeof getUnifiedSkillsByIds>>) {
  return skills.map((skill) => (
    [
      'מצורף סקיל להבנה:',
      `שם הסקיל: ${skill.displayName}`,
      `מקור הסקיל: ${skill.sourceLabel} (${skill.providerOrigin})`,
      `מיקום הסקיל: ${skill.path}`,
      `תיאור הסקיל לצורך ההבנה: ${skill.description || 'ללא תיאור.'}`,
    ].join('\n')
  )).join('\n\n');
}

function renderReminderBlock(reminders: Awaited<ReturnType<typeof getSessionRemindersByIds>>) {
  return reminders.map((reminder) => (
    [
      'מצורף תזכורת על מה שכבר דיברנו בסשן זה:',
      `שם התזכורת: ${reminder.name}`,
      'תוכן התזכורת:',
      reminder.content,
    ].join('\n')
  )).join('\n\n');
}

export function buildActionRestrictionPromptAdditions(
  restriction: NonNullable<Awaited<ReturnType<typeof getSessionContextSelection>>['actionRestriction']>
) {
  if (restriction.enabled !== true) {
    return [
      'מצב הגבלת פעולה בוטל:',
      `ההגבלה הקודמת על ${restriction.targetKind === 'file' ? 'הקובץ' : 'התיקייה'} ${restriction.targetPath} אינה פעילה יותר.`,
      'החל מהודעה זו אין מגבלת כתיבה ייעודית של מצב הגבלת פעולה.',
      'אם המשתמש לא הוסיף מגבלה חדשה, אפשר לחזור להתנהגות הרגילה של הסשן.',
    ].join('\n');
  }

  return [
    'מצב הגבלת פעולה פעיל:',
    `מותר לך לערוך רק ${restriction.targetKind === 'file' ? 'את הקובץ' : 'בתוך התיקייה'}: ${restriction.targetPath}`,
    'אסור לך לכתוב, למחוק, לשנות שם או ליצור קבצים מחוץ לנתיב הזה.',
    'אם שינוי הכרחי נוגע לנתיב אחר, עצור, דווח על כך במפורש, ואל תנסה לעקוף את ההגבלה.',
    'אם כלי כלשהו יחזיר שינוי מחוץ לנתיב הזה, השרת עשוי לדחות את הפעולה ולהחזיר שגיאת הרשאה.',
  ].join('\n');
}

export async function buildSessionPromptAdditionsContext(options: {
  profileId: string;
  sessionKey: string;
  cwd: string | null;
}): Promise<string | null> {
  const selection = await getSessionContextSelection(options.profileId, options.sessionKey);
  if (
    selection.anchorIds.length === 0
    && selection.skillIds.length === 0
    && selection.reminderIds.length === 0
    && !selection.actionRestriction
  ) {
    return null;
  }

  const [allAnchors, selectedSkills, selectedReminders] = await Promise.all([
    options.cwd ? listProjectAnchors(options.cwd) : Promise.resolve([]),
    getUnifiedSkillsByIds(selection.skillIds),
    getSessionRemindersByIds(options.profileId, options.sessionKey, selection.reminderIds),
  ]);
  const selectedAnchorIdSet = new Set(selection.anchorIds);
  const selectedAnchors = allAnchors.filter((anchor) => selectedAnchorIdSet.has(anchor.id));

  if (
    selectedAnchors.length === 0
    && selectedSkills.length === 0
    && selectedReminders.length === 0
    && !selection.actionRestriction
  ) {
    return null;
  }

  const packSections = [
    '# Code-AI context pack',
    'הקובץ הזה נוצר על ידי Code-AI כדי לטעון לשיחה עוגנים, סקילים ותזכורות שנבחרו ידנית למהלך השיחה.',
  ];

  if (selection.actionRestriction) {
    packSections.push(
      selection.actionRestriction.enabled ? '## הגבלת פעולה פעילה' : '## הגבלת פעולה בוטלה',
      buildActionRestrictionPromptAdditions(selection.actionRestriction)
    );
  }

  if (selectedAnchors.length > 0) {
    packSections.push('## עוגנים נבחרים', renderAnchorBlock(selectedAnchors));
  }

  if (selectedSkills.length > 0) {
    packSections.push('## סקילים נבחרים', renderSkillBlock(selectedSkills));
  }

  if (selectedReminders.length > 0) {
    packSections.push('## תזכורות נבחרות', renderReminderBlock(selectedReminders));
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
  const remindersPreview = selectedReminders.length > 0
    ? `תזכורות פעילות: ${selectedReminders.map((reminder) => reminder.name).join(', ')}.`
    : null;
  const restrictionPreview = selection.actionRestriction
    ? (
      selection.actionRestriction.enabled
        ? `הגבלת פעולה פעילה: ${selection.actionRestriction.targetKind === 'file' ? 'קובץ' : 'תיקייה'} ${selection.actionRestriction.targetPath}.`
        : `הגבלת פעולה בוטלה: ${selection.actionRestriction.targetKind === 'file' ? 'קובץ' : 'תיקייה'} ${selection.actionRestriction.targetPath}.`
    )
    : null;

  return [
    anchorsPreview,
    skillsPreview,
    remindersPreview,
    restrictionPreview,
    'הפריטים הבאים מצורפים להודעה הנוכחית כהקשר להבנה ולביצוע:',
    packContent.trim().replace(/^# Code-AI context pack\s*/m, '').replace(/^הקובץ הזה נוצר על ידי Code-AI כדי לטעון לשיחה עוגנים, סקילים ותזכורות שנבחרו ידנית למהלך השיחה\.\s*/m, '').trim(),
    `קובץ מעקב מקומי: ${packPath}`,
  ].filter(Boolean).join('\n\n');
}
