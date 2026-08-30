import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';
import type { CodexProfile } from './codexService.js';

export type CodexConversationSearchScope = 'current' | 'project' | 'all';

export interface CodexSessionConversationSearchMode {
  enabled: boolean;
  scope: CodexConversationSearchScope;
  projectRoot: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CodexSessionConversationSearchModeInput {
  enabled?: boolean;
  scope?: CodexConversationSearchScope | null;
  projectRoot?: string | null;
}

interface ConversationSearchModeState {
  modesByKey: Record<string, CodexSessionConversationSearchMode>;
}

const SEARCH_MODE_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'local', 'conversation-search-mode');
const SEARCH_MODE_INDEX_ROOT = path.join(SEARCH_MODE_ROOT, 'index-v1');
const SEARCH_MODE_STATE_FILE = path.join(SEARCH_MODE_ROOT, 'session-conversation-search-mode.json');
const SEARCH_MODE_SKILL_ROOT = path.join(CODEX_APP_CONFIG.appRoot, 'skills', 'code-ai-conversation-search');
const SEARCH_MODE_SCRIPT = path.join(SEARCH_MODE_SKILL_ROOT, 'scripts', 'search_sessions.mjs');
const SESSION_TITLES_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-titles.json');

let loadPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: ConversationSearchModeState = { modesByKey: {} };

function nowIso(): string {
  return new Date().toISOString();
}

function stateKey(profileId: string, sessionKey: string): string {
  return `${profileId}:${sessionKey}`;
}

function cleanPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  return path.resolve(value.trim().slice(0, 4_000));
}

function normalizeScope(value: unknown): CodexConversationSearchScope {
  return value === 'project' || value === 'all' ? value : 'current';
}

function normalizeMode(
  value: CodexSessionConversationSearchModeInput | CodexSessionConversationSearchMode | null | undefined,
  current?: CodexSessionConversationSearchMode | null,
): CodexSessionConversationSearchMode {
  const fallback = current || createEmptySessionConversationSearchMode();
  const candidate = value || {};
  return {
    enabled: candidate.enabled === true,
    scope: normalizeScope(candidate.scope ?? fallback.scope),
    projectRoot: cleanPath(candidate.projectRoot ?? fallback.projectRoot),
    createdAt: typeof (candidate as CodexSessionConversationSearchMode).createdAt === 'string'
      ? (candidate as CodexSessionConversationSearchMode).createdAt
      : fallback.createdAt,
    updatedAt: typeof (candidate as CodexSessionConversationSearchMode).updatedAt === 'string'
      ? (candidate as CodexSessionConversationSearchMode).updatedAt
      : fallback.updatedAt,
  };
}

function cloneMode(mode: CodexSessionConversationSearchMode): CodexSessionConversationSearchMode {
  return { ...mode };
}

async function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(SEARCH_MODE_STATE_FILE, 'utf8')) as Partial<ConversationSearchModeState>;
        state = {
          modesByKey: Object.fromEntries(
            Object.entries(parsed.modesByKey || {}).map(([key, value]) => [key, normalizeMode(value)]),
          ),
        };
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        state = { modesByKey: {} };
      }
    })();
  }
  await loadPromise;
}

async function persist(): Promise<void> {
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  persistTail = persistTail.then(async () => {
    await fs.mkdir(SEARCH_MODE_ROOT, { recursive: true, mode: 0o700 });
    const temporaryPath = `${SEARCH_MODE_STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, SEARCH_MODE_STATE_FILE);
  });
  await persistTail;
}

export function createEmptySessionConversationSearchMode(projectRoot = ''): CodexSessionConversationSearchMode {
  return {
    enabled: false,
    scope: 'current',
    projectRoot: cleanPath(projectRoot),
    createdAt: null,
    updatedAt: null,
  };
}

export async function validateSessionConversationSearchMode(
  profile: Pick<CodexProfile, 'provider'>,
  value: CodexSessionConversationSearchModeInput | null | undefined,
  current?: CodexSessionConversationSearchMode | null,
): Promise<CodexSessionConversationSearchMode> {
  const normalized = normalizeMode(value, current);
  if (!normalized.enabled) return normalized;
  if (profile.provider !== 'codex') throw new Error('מצב חיפוש בשיחות זמין כרגע רק לסשני Codex.');
  const skill = await fs.stat(path.join(SEARCH_MODE_SKILL_ROOT, 'SKILL.md')).catch(() => null);
  const script = await fs.stat(SEARCH_MODE_SCRIPT).catch(() => null);
  if (!skill?.isFile() || !script?.isFile()) {
    throw new Error('סקיל החיפוש של CODE-AI אינו מותקן בשלמותו בשרת.');
  }
  if (normalized.scope === 'project') {
    if (!normalized.projectRoot) throw new Error('חיפוש בכל שיחות הפרויקט דורש תיקיית פרויקט פעילה.');
    const project = await fs.stat(normalized.projectRoot).catch(() => null);
    if (!project?.isDirectory()) throw new Error('תיקיית הפרויקט שנבחרה לחיפוש אינה קיימת או אינה נגישה.');
  }
  return normalized;
}

export async function getSessionConversationSearchMode(
  profileId: string,
  sessionKey: string,
  projectRoot = '',
): Promise<CodexSessionConversationSearchMode> {
  await ensureLoaded();
  return cloneMode(state.modesByKey[stateKey(profileId, sessionKey)] || createEmptySessionConversationSearchMode(projectRoot));
}

export async function getSessionConversationSearchModeRecord(
  profileId: string,
  sessionKey: string,
): Promise<CodexSessionConversationSearchMode | null> {
  await ensureLoaded();
  const record = state.modesByKey[stateKey(profileId, sessionKey)];
  return record ? cloneMode(record) : null;
}

export async function setSessionConversationSearchMode(
  profileId: string,
  sessionKey: string,
  value: CodexSessionConversationSearchModeInput | CodexSessionConversationSearchMode,
): Promise<CodexSessionConversationSearchMode> {
  await ensureLoaded();
  const key = stateKey(profileId, sessionKey);
  const previous = state.modesByKey[key];
  const timestamp = nowIso();
  const normalized = normalizeMode(value, previous);
  const record: CodexSessionConversationSearchMode = {
    ...normalized,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  state.modesByKey[key] = record;
  await persist();
  return cloneMode(record);
}

export async function rebindSessionConversationSearchMode(
  profileId: string,
  fromSessionKey: string,
  toSessionKey: string,
): Promise<void> {
  await ensureLoaded();
  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) return;
  const fromKey = stateKey(profileId, fromSessionKey);
  const record = state.modesByKey[fromKey];
  if (!record) return;
  state.modesByKey[stateKey(profileId, toSessionKey)] = { ...cloneMode(record), updatedAt: nowIso() };
  delete state.modesByKey[fromKey];
  await persist();
}

export async function deleteSessionConversationSearchMode(profileId: string, sessionKey: string): Promise<void> {
  await ensureLoaded();
  const key = stateKey(profileId, sessionKey);
  if (!state.modesByKey[key]) return;
  delete state.modesByKey[key];
  await persist();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function scopeLabel(scope: CodexConversationSearchScope): string {
  if (scope === 'project') return 'כל שיחות הפרויקט';
  if (scope === 'all') return 'כל השיחות הנגישות';
  return 'השיחה הנוכחית בלבד';
}

function publicSessionBaseUrl(): string {
  const host = CODEX_APP_CONFIG.publicHosts.find((candidate) => candidate.startsWith('app-codex.'))
    || CODEX_APP_CONFIG.publicHosts[0]
    || 'app-codex.bina-cshera.co.il';
  return /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`;
}

export function buildSessionConversationSearchModePromptAdditions(options: {
  mode: CodexSessionConversationSearchMode;
  profileId: string;
  sessionKey: string;
  cwd: string | null;
}): string {
  const { mode, profileId, sessionKey, cwd } = options;
  if (!mode.enabled) return 'מצב חיפוש בשיחות אינו פעיל.';
  const profiles = CODEX_APP_CONFIG.profiles
    .filter((profile) => profile.provider === 'codex' && profile.mode === 'standard' && !profile.internalOnly)
    .map((profile) => ({ id: profile.id, codexHome: profile.codexHome }));
  if (!profiles.some((profile) => profile.id === profileId)) {
    const current = CODEX_APP_CONFIG.profiles.find((profile) => profile.id === profileId);
    if (current?.provider === 'codex') profiles.unshift({ id: current.id, codexHome: current.codexHome });
  }
  const projectRoot = mode.projectRoot || cwd || '';
  const profileArguments = profiles.map((profile) => `--profile ${shellQuote(`${profile.id}=${profile.codexHome}`)}`).join(' ');
  const command = [
    `node ${shellQuote(SEARCH_MODE_SCRIPT)}`,
    `--scope ${mode.scope}`,
    '--query <כתוב כאן את שאילתת החיפוש המדויקת מתוך בקשת המשתמש>',
    `--session-id ${shellQuote(sessionKey)}`,
    projectRoot ? `--project-root ${shellQuote(projectRoot)}` : '',
    profileArguments,
    `--titles-file ${shellQuote(SESSION_TITLES_FILE)}`,
    `--index-root ${shellQuote(SEARCH_MODE_INDEX_ROOT)}`,
    `--base-url ${shellQuote(publicSessionBaseUrl())}`,
    '--limit 20',
  ].filter(Boolean).join(' ');
  return [
    'מצב חיפוש בשיחות פעיל:',
    `טווח החיפוש המחייב: ${scopeLabel(mode.scope)} (${mode.scope}). אסור להרחיב את הטווח בלי אישור מפורש של המשתמש.`,
    `הסשן הנוכחי: ${sessionKey}; הפרופיל הנוכחי: ${profileId}; תיקיית העבודה: ${cwd || 'לא ידועה'}.`,
    mode.scope === 'project' ? `שורש הפרויקט המחייב: ${projectRoot}. קבע שייכות לפי cwd שב-session_meta, לא לפי אזכור נתיב בתוך הודעה.` : '',
    `קרא במלואו ופעל לפי הסקיל $code-ai-conversation-search שבנתיב: ${path.join(SEARCH_MODE_SKILL_ROOT, 'SKILL.md')}`,
    'השתמש קודם בסקריפט הדטרמיניסטי של הסקיל, ורק אחר כך אמת את ההקשר בקובצי המקור של המועמדים החזקים:',
    command,
    `מאגרי הסשנים המותרים בטווח all/project: ${profiles.map((profile) => `${profile.id}=${profile.codexHome}`).join(', ') || 'רק CODEX_HOME הנוכחי'}.`,
    'חפש רק הודעות משתמש ותשובות סוכן אמיתיות; אל תציג פלט כלי, הוראות מערכת, תוכן דף, compaction או עותק fork כאילו היו הדיון המקורי.',
    'בתשובה החזר תחילה את ההתאמה הטובה ביותר עם ראיה קצרה וקישור ישיר לסשן. אם אין התאמה, אמור זאת במפורש ואל תמציא.',
  ].filter(Boolean).join('\n\n');
}

export const CONVERSATION_SEARCH_MODE_SKILL_PATH = SEARCH_MODE_SKILL_ROOT;
export const CONVERSATION_SEARCH_MODE_SCRIPT_PATH = SEARCH_MODE_SCRIPT;
