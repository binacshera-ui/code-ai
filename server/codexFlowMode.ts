import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';
import {
  createEmptyFlowDocument,
  extractFlowDocumentsFromText,
  normalizeFlowDocument,
  type FlowDocument,
} from '../shared/flowMode.js';

export type FlowModeDetail = 'simple' | 'balanced' | 'deep';

export interface CodexSessionFlowMode {
  enabled: boolean;
  detail: FlowModeDetail;
  brief: string;
  document: FlowDocument | null;
  revision: number;
  updatedAt: string | null;
  lastGeneratedAt: string | null;
  source: 'agent' | 'user' | null;
}

interface PersistedFlowModeRecord extends CodexSessionFlowMode {
  profileId: string;
  sessionKey: string;
}

interface FlowModeState {
  records: Record<string, PersistedFlowModeRecord>;
}

const STATE_DIR = path.join(CODEX_APP_CONFIG.storageRoot, 'local');
const STATE_FILE = path.join(STATE_DIR, 'session-flow-mode.json');
let state: FlowModeState = { records: {} };
let loaded = false;
let loadPromise: Promise<void> | null = null;
let persistTail = Promise.resolve();

function key(profileId: string, sessionKey: string) {
  return `${profileId.trim()}::${sessionKey.trim()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultMode(): CodexSessionFlowMode {
  return {
    enabled: false,
    detail: 'balanced',
    brief: '',
    document: null,
    revision: 0,
    updatedAt: null,
    lastGeneratedAt: null,
    source: null,
  };
}

function normalizeDetail(value: unknown): FlowModeDetail {
  return value === 'simple' || value === 'deep' ? value : 'balanced';
}

function normalizeRecord(value: unknown): PersistedFlowModeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const profileId = typeof raw.profileId === 'string' ? raw.profileId.trim() : '';
  const sessionKey = typeof raw.sessionKey === 'string' ? raw.sessionKey.trim() : '';
  if (!profileId || !sessionKey) return null;
  let document: FlowDocument | null = null;
  if (raw.document) {
    try {
      document = normalizeFlowDocument(raw.document);
    } catch {
      document = null;
    }
  }
  return {
    profileId,
    sessionKey,
    enabled: raw.enabled === true,
    detail: normalizeDetail(raw.detail),
    brief: typeof raw.brief === 'string' ? raw.brief.trim().slice(0, 1600) : '',
    document,
    revision: Number.isFinite(raw.revision) ? Math.max(0, Math.floor(Number(raw.revision))) : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    lastGeneratedAt: typeof raw.lastGeneratedAt === 'string' ? raw.lastGeneratedAt : null,
    source: raw.source === 'agent' || raw.source === 'user' ? raw.source : null,
  };
}

async function ensureLoaded() {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await fs.mkdir(STATE_DIR, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as Partial<FlowModeState>;
      const records: Record<string, PersistedFlowModeRecord> = {};
      for (const value of Object.values(parsed.records || {})) {
        const record = normalizeRecord(value);
        if (record) records[key(record.profileId, record.sessionKey)] = record;
      }
      state = { records };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.warn('[flow-mode] Could not load state:', error?.message || error);
      state = { records: {} };
    }
    loaded = true;
  })().finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

async function persist() {
  persistTail = persistTail.then(async () => {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const temporary = `${STATE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, STATE_FILE);
  });
  return persistTail;
}

function toClient(record: PersistedFlowModeRecord | undefined): CodexSessionFlowMode {
  if (!record) return defaultMode();
  return {
    enabled: record.enabled,
    detail: record.detail,
    brief: record.brief,
    document: record.document ? structuredClone(record.document) : null,
    revision: record.revision,
    updatedAt: record.updatedAt,
    lastGeneratedAt: record.lastGeneratedAt,
    source: record.source,
  };
}

export async function getSessionFlowMode(profileId: string, sessionKey: string): Promise<CodexSessionFlowMode> {
  await ensureLoaded();
  return toClient(state.records[key(profileId, sessionKey)]);
}

export async function getSessionFlowModeRecord(profileId: string, sessionKey: string): Promise<PersistedFlowModeRecord | null> {
  await ensureLoaded();
  return state.records[key(profileId, sessionKey)] || null;
}

export async function setSessionFlowMode(
  profileId: string,
  sessionKey: string,
  input: {
    enabled?: boolean;
    detail?: FlowModeDetail;
    brief?: string;
    document?: unknown;
    expectedRevision?: number;
    source?: 'agent' | 'user';
  },
): Promise<CodexSessionFlowMode> {
  await ensureLoaded();
  const recordKey = key(profileId, sessionKey);
  const current = state.records[recordKey];
  const currentRevision = current?.revision || 0;
  if (Number.isFinite(input.expectedRevision) && Number(input.expectedRevision) !== currentRevision) {
    const error = new Error('הזרימה השתנתה במקום אחר. רענן אותה לפני השמירה כדי לא לדרוס שינוי חדש.') as Error & { statusCode?: number };
    error.statusCode = 409;
    throw error;
  }
  const timestamp = nowIso();
  const hasDocument = Object.prototype.hasOwnProperty.call(input, 'document');
  const document = hasDocument
    ? (input.document ? normalizeFlowDocument(input.document, timestamp) : null)
    : current?.document || null;
  const next: PersistedFlowModeRecord = {
    profileId: profileId.trim(),
    sessionKey: sessionKey.trim(),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current?.enabled === true,
    detail: normalizeDetail(input.detail ?? current?.detail),
    brief: typeof input.brief === 'string' ? input.brief.trim().slice(0, 1600) : current?.brief || '',
    document,
    revision: currentRevision + 1,
    updatedAt: timestamp,
    lastGeneratedAt: input.source === 'agent' && hasDocument ? timestamp : current?.lastGeneratedAt || null,
    source: input.source || current?.source || null,
  };
  state.records[recordKey] = next;
  await persist();
  return toClient(next);
}

export async function ingestSessionFlowDocumentFromText(
  profileId: string,
  sessionKey: string,
  value: string | null | undefined,
  expectedBaseRevision?: number,
): Promise<CodexSessionFlowMode | null> {
  if (!value) return null;
  const current = await getSessionFlowModeRecord(profileId, sessionKey);
  if (!current?.enabled) return null;
  if (Number.isFinite(expectedBaseRevision) && current.revision !== expectedBaseRevision) {
    return null;
  }
  const documents = extractFlowDocumentsFromText(value);
  const document = documents.at(-1);
  if (!document) return null;
  try {
    return await setSessionFlowMode(profileId, sessionKey, {
      enabled: true,
      detail: current.detail,
      brief: current.brief,
      document,
      expectedRevision: current.revision,
      source: 'agent',
    });
  } catch (error: any) {
    if (error?.statusCode === 409) return null;
    throw error;
  }
}

export async function rebindSessionFlowMode(profileId: string, fromSessionKey: string, toSessionKey: string): Promise<void> {
  await ensureLoaded();
  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) return;
  const fromKey = key(profileId, fromSessionKey);
  const source = state.records[fromKey];
  if (!source) return;
  const toKey = key(profileId, toSessionKey);
  const destination = state.records[toKey];
  const sourceTime = Date.parse(source.updatedAt || '') || 0;
  const destinationTime = Date.parse(destination?.updatedAt || '') || 0;
  if (!destination || sourceTime >= destinationTime) {
    state.records[toKey] = { ...source, sessionKey: toSessionKey };
  }
  delete state.records[fromKey];
  await persist();
}

export async function deleteSessionFlowMode(profileId: string, sessionKey: string): Promise<void> {
  await ensureLoaded();
  const recordKey = key(profileId, sessionKey);
  if (!state.records[recordKey]) return;
  delete state.records[recordKey];
  await persist();
}

export async function buildSessionFlowModePromptAdditions(profileId: string, sessionKey: string): Promise<string | null> {
  const mode = await getSessionFlowMode(profileId, sessionKey);
  if (!mode.enabled) return null;
  const detailLabel = mode.detail === 'simple' ? 'פשוט ותמציתי' : mode.detail === 'deep' ? 'עמוק ומפורט' : 'מאוזן';
  const currentDocument = mode.document || createEmptyFlowDocument();
  return [
    'מצב יצירת זרימה פעיל בסשן הזה.',
    'המטרה: להפוך את המערכת האמיתית למפה חזותית בהירה, נעימה ואמינה בעברית פשוטה ואנושית.',
    `רמת פירוט מבוקשת: ${detailLabel}.`,
    mode.brief ? `דגש מיוחד של המשתמש: ${mode.brief}` : null,
    'בדוק את הקוד, הקונפיגורציה והריצה בפועל לפני קביעה. הפרד במפורש בין רכיב שנמצא בריפו, שירות חיצוני, שירות מנוהל, תשתית או מצב לא ידוע. אל תמציא ודאות; הוסף ראיות של path/url/runtime/note כאשר הן ידועות.',
    'כתוב לכל מודול title קצר, summary של משפט אחד ו-description אנושי שמסביר מה הוא עושה, למה הוא קיים, עם מי הוא מדבר ומה חשוב לדעת עליו.',
    'בנה את המפה כזרימה מכוונת שאפשר לקרוא מהתחלה לסוף: source הוא תמיד הרכיב ששולח/מפעיל/יוזם ו-target הוא הרכיב שמקבל/מופעל. סמן flowRole="entry" לנקודות כניסה אמיתיות, "exit" לסיום או תוצאה אמיתיים, "decision" להסתעפות, ו-"support" למסד נתונים, תור או תשתית שאינם שלב ראשי. השתמש ב-"auto" רק כשאין ודאות.',
    'שמור את הנתיב הראשי קצר וברור והעבר תלות או פריסה משנית ל-edge kind מתאים. אל תחבר כל רכיב לכל רכיב רק כדי להראות תלות עקיפה; כל חץ חייב לתאר מעבר ישיר ואמיתי.',
    'בסוף התשובה חובה להוסיף בלוק יחיד ומלא של JSON תקין בגדר קוד בשם bina-flow. הבלוק הוא snapshot מלא שמחליף את הקודם, לא patch. אין להוסיף הערות בתוך JSON.',
    'הסכימה: {schemaVersion:1,id,title,subtitle,summary,direction:"rtl"|"ltr",layoutVersion:0,groups:[{id,title,description,color:"sky"|"mint"|"violet"|"rose"|"amber"|"slate"}],nodes:[{id,title,summary,description,kind:"system"|"ui"|"api"|"service"|"worker"|"database"|"queue"|"container"|"external"|"file"|"decision"|"person"|"other",ownership:"repository"|"external"|"managed"|"infrastructure"|"unknown",status:"active"|"planned"|"risk"|"unknown",flowRole:"auto"|"entry"|"step"|"decision"|"exit"|"support",groupId:null|string,technology,runtime,repositoryPath,externalUrl,tags:string[],evidence:[{id,kind:"path"|"url"|"runtime"|"note",label,value}],position:null}],edges:[{id,source,target,label,description,kind:"data"|"request"|"event"|"dependency"|"control"|"deploy"|"other"}],updatedAt}. קבע layoutVersion:0 ו-position:null כדי שמנוע הסידור המקצועי של הממשק יבנה שכבות ללא חפיפות.',
    'שמור מזהים קיימים כאשר אותו מודול עדיין קיים. אם המשתמש מבקש להוסיף, להסיר או לשנות מודול — עדכן את ה-snapshot בהתאם. אם הפעולה כוללת גם שינוי קוד, בצע את עבודת הקוד ובסוף עדכן את המפה למה שקיים בפועל.',
    'הזרימה הקנונית הנוכחית (זהו ההקשר המלא והעדכני לעריכה):',
    JSON.stringify(currentDocument),
  ].filter(Boolean).join('\n\n');
}
