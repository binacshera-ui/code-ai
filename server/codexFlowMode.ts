import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';
import {
  FLOW_MAX_MAPS_PER_SESSION,
  createEmptyFlowDocument,
  extractFlowDocumentsFromText,
  normalizeFlowDocument,
  type FlowDocument,
  type FlowMapSummary,
} from '../shared/flowMode.js';

export type FlowModeDetail = 'simple' | 'balanced' | 'deep';

export interface CodexSessionFlowMode {
  enabled: boolean;
  detail: FlowModeDetail;
  brief: string;
  activeMapId: string | null;
  maps: FlowMapSummary[];
  document: FlowDocument | null;
  mapRevision: number;
  revision: number;
  updatedAt: string | null;
  lastGeneratedAt: string | null;
  source: 'agent' | 'user' | null;
}

interface PersistedFlowMap {
  id: string;
  document: FlowDocument;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastGeneratedAt: string | null;
  source: 'agent' | 'user' | null;
}

interface PersistedFlowModeRecord {
  profileId: string;
  sessionKey: string;
  enabled: boolean;
  detail: FlowModeDetail;
  brief: string;
  activeMapId: string | null;
  maps: PersistedFlowMap[];
  revision: number;
  updatedAt: string | null;
}

export type FlowMapOperation = 'save' | 'create' | 'select' | 'rename' | 'duplicate' | 'delete';

export interface SessionFlowModeMutation {
  operation?: FlowMapOperation;
  enabled?: boolean;
  detail?: FlowModeDetail;
  brief?: string;
  mapId?: string | null;
  title?: string;
  document?: unknown;
  expectedRevision?: number;
  expectedMapRevision?: number;
  source?: 'agent' | 'user';
}

export interface FlowMapExecutionTarget {
  mapId: string;
  mapRevision: number;
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
    activeMapId: null,
    maps: [],
    document: null,
    mapRevision: 0,
    revision: 0,
    updatedAt: null,
    lastGeneratedAt: null,
    source: null,
  };
}

function normalizeDetail(value: unknown): FlowModeDetail {
  return value === 'simple' || value === 'deep' ? value : 'balanced';
}

function text(value: unknown, fallback = '', maxLength = 180): string {
  return (typeof value === 'string' ? value.trim() : fallback).slice(0, maxLength);
}

function mapToken(value: unknown, fallback: string): string {
  return text(value, fallback, 120)
    .replace(/[^\p{L}\p{N}_.:-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function createMapId() {
  return `map-${randomUUID()}`;
}

function createDocumentForMap(title: string, timestamp: string): FlowDocument {
  const document = createEmptyFlowDocument(timestamp);
  return {
    ...document,
    id: `flow-${randomUUID()}`,
    title: text(title, 'מפה חדשה') || 'מפה חדשה',
  };
}

function normalizePersistedMap(value: unknown, fallbackId: string, fallbackTimestamp: string): PersistedFlowMap | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  try {
    const document = normalizeFlowDocument(raw.document, fallbackTimestamp);
    const createdAt = text(raw.createdAt, document.updatedAt || fallbackTimestamp, 80) || fallbackTimestamp;
    const updatedAt = text(raw.updatedAt, document.updatedAt || createdAt, 80) || createdAt;
    return {
      id: mapToken(raw.id, fallbackId),
      document,
      revision: Number.isFinite(raw.revision) ? Math.max(1, Math.floor(Number(raw.revision))) : 1,
      createdAt,
      updatedAt,
      lastGeneratedAt: typeof raw.lastGeneratedAt === 'string' ? raw.lastGeneratedAt : null,
      source: raw.source === 'agent' || raw.source === 'user' ? raw.source : null,
    };
  } catch {
    return null;
  }
}

export function normalizeFlowModeRecord(value: unknown): PersistedFlowModeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const profileId = typeof raw.profileId === 'string' ? raw.profileId.trim() : '';
  const sessionKey = typeof raw.sessionKey === 'string' ? raw.sessionKey.trim() : '';
  if (!profileId || !sessionKey) return null;

  const fallbackTimestamp = typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso();
  const maps: PersistedFlowMap[] = [];
  const mapIds = new Set<string>();
  const rawMaps = Array.isArray(raw.maps) ? raw.maps : [];
  for (const [index, entry] of rawMaps.slice(0, FLOW_MAX_MAPS_PER_SESSION).entries()) {
    const normalized = normalizePersistedMap(entry, `map-${index + 1}`, fallbackTimestamp);
    if (!normalized || mapIds.has(normalized.id)) continue;
    mapIds.add(normalized.id);
    maps.push(normalized);
  }

  // Version-1 records stored one document directly on the session. Promote it
  // to the first map in memory; the next legitimate write persists version 2.
  if (maps.length === 0 && raw.document) {
    const legacy = normalizePersistedMap({
      id: `map-${(raw.document as Record<string, unknown>)?.id || 'main'}`,
      document: raw.document,
      revision: raw.revision,
      createdAt: raw.updatedAt,
      updatedAt: raw.updatedAt,
      lastGeneratedAt: raw.lastGeneratedAt,
      source: raw.source,
    }, 'map-main', fallbackTimestamp);
    if (legacy) maps.push(legacy);
  }

  const requestedActiveMapId = typeof raw.activeMapId === 'string' ? raw.activeMapId : '';
  const activeMapId = maps.some((map) => map.id === requestedActiveMapId)
    ? requestedActiveMapId
    : maps[0]?.id || null;
  return {
    profileId,
    sessionKey,
    enabled: raw.enabled === true,
    detail: normalizeDetail(raw.detail),
    brief: typeof raw.brief === 'string' ? raw.brief.trim().slice(0, 1600) : '',
    activeMapId,
    maps,
    revision: Number.isFinite(raw.revision) ? Math.max(0, Math.floor(Number(raw.revision))) : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
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
        const record = normalizeFlowModeRecord(value);
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
  const activeMap = record.maps.find((map) => map.id === record.activeMapId) || null;
  return {
    enabled: record.enabled,
    detail: record.detail,
    brief: record.brief,
    activeMapId: activeMap?.id || null,
    maps: record.maps.map((map): FlowMapSummary => ({
      id: map.id,
      title: map.document.title,
      subtitle: map.document.subtitle,
      nodeCount: map.document.nodes.length,
      edgeCount: map.document.edges.length,
      revision: map.revision,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
      lastGeneratedAt: map.lastGeneratedAt,
      source: map.source,
    })),
    document: activeMap ? structuredClone(activeMap.document) : null,
    mapRevision: activeMap?.revision || 0,
    revision: record.revision,
    updatedAt: record.updatedAt,
    lastGeneratedAt: activeMap?.lastGeneratedAt || null,
    source: activeMap?.source || null,
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
  input: SessionFlowModeMutation,
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

  const operation: FlowMapOperation = input.operation && ['save', 'create', 'select', 'rename', 'duplicate', 'delete'].includes(input.operation)
    ? input.operation
    : 'save';
  const timestamp = nowIso();
  const maps = (current?.maps || []).map((map) => structuredClone(map));
  let activeMapId = current?.activeMapId || maps[0]?.id || null;
  const explicitMapId = text(input.mapId, '', 120);
  const requestedMapId = explicitMapId || activeMapId;
  const requestedTitle = text(input.title, '', 180);
  const hasDocument = Object.prototype.hasOwnProperty.call(input, 'document');

  const findMapIndex = (mapId: string | null) => mapId ? maps.findIndex((map) => map.id === mapId) : -1;
  const requireMapIndex = (mapId: string | null) => {
    const index = findMapIndex(mapId);
    if (index >= 0) return index;
    const error = new Error('המפה המבוקשת כבר אינה קיימת בסשן.') as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  };
  const assertMapRevision = (map: PersistedFlowMap) => {
    if (Number.isFinite(input.expectedMapRevision) && Number(input.expectedMapRevision) !== map.revision) {
      const error = new Error('המפה השתנתה במקום אחר. רענן אותה לפני השמירה כדי לא לדרוס שינוי חדש.') as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
  };
  const assertCapacity = () => {
    if (maps.length >= FLOW_MAX_MAPS_PER_SESSION) {
      const error = new Error(`אפשר לשמור עד ${FLOW_MAX_MAPS_PER_SESSION} מפות בסשן אחד.`) as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
  };

  if (operation === 'create') {
    assertCapacity();
    const id = createMapId();
    maps.push({
      id,
      document: createDocumentForMap(requestedTitle || `מפה ${maps.length + 1}`, timestamp),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastGeneratedAt: null,
      source: 'user',
    });
    activeMapId = id;
  } else if (operation === 'select') {
    activeMapId = maps[requireMapIndex(requestedMapId)].id;
  } else if (operation === 'rename') {
    const index = requireMapIndex(requestedMapId);
    assertMapRevision(maps[index]);
    if (!requestedTitle) throw new Error('יש להזין שם למפה.');
    maps[index] = {
      ...maps[index],
      document: { ...maps[index].document, title: requestedTitle, updatedAt: timestamp },
      revision: maps[index].revision + 1,
      updatedAt: timestamp,
      source: 'user',
    };
  } else if (operation === 'duplicate') {
    assertCapacity();
    const source = maps[requireMapIndex(requestedMapId)];
    assertMapRevision(source);
    const id = createMapId();
    const document = structuredClone(source.document);
    maps.push({
      id,
      document: {
        ...document,
        id: `flow-${randomUUID()}`,
        title: requestedTitle || `${document.title} — עותק`,
        updatedAt: timestamp,
      },
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastGeneratedAt: null,
      source: 'user',
    });
    activeMapId = id;
  } else if (operation === 'delete') {
    const index = requireMapIndex(requestedMapId);
    assertMapRevision(maps[index]);
    const [removed] = maps.splice(index, 1);
    if (activeMapId === removed.id) activeMapId = maps[Math.min(index, maps.length - 1)]?.id || null;
  } else {
    const index = findMapIndex(requestedMapId);
    if (hasDocument && input.document) {
      const document = normalizeFlowDocument(input.document, timestamp);
      if (index >= 0) {
        assertMapRevision(maps[index]);
        maps[index] = {
          ...maps[index],
          document,
          revision: maps[index].revision + 1,
          updatedAt: timestamp,
          lastGeneratedAt: input.source === 'agent' ? timestamp : maps[index].lastGeneratedAt,
          source: input.source || maps[index].source,
        };
      } else if (explicitMapId) {
        const error = new Error('המפה המבוקשת כבר אינה קיימת בסשן.') as Error & { statusCode?: number };
        error.statusCode = 404;
        throw error;
      } else {
        assertCapacity();
        const id = createMapId();
        maps.push({
          id,
          document,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastGeneratedAt: input.source === 'agent' ? timestamp : null,
          source: input.source || null,
        });
        activeMapId = id;
      }
    } else if (hasDocument && !input.document && index >= 0) {
      assertMapRevision(maps[index]);
      const [removed] = maps.splice(index, 1);
      if (activeMapId === removed.id) activeMapId = maps[Math.min(index, maps.length - 1)]?.id || null;
    }
  }

  if (!maps.some((map) => map.id === activeMapId)) activeMapId = maps[0]?.id || null;
  const next: PersistedFlowModeRecord = {
    profileId: profileId.trim(),
    sessionKey: sessionKey.trim(),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current?.enabled === true,
    detail: normalizeDetail(input.detail ?? current?.detail),
    brief: typeof input.brief === 'string' ? input.brief.trim().slice(0, 1600) : current?.brief || '',
    activeMapId,
    maps,
    revision: currentRevision + 1,
    updatedAt: timestamp,
  };
  state.records[recordKey] = next;
  await persist();
  return toClient(next);
}

export async function ingestSessionFlowDocumentFromText(
  profileId: string,
  sessionKey: string,
  value: string | null | undefined,
  executionTarget?: FlowMapExecutionTarget,
): Promise<CodexSessionFlowMode | null> {
  if (!value) return null;
  const current = await getSessionFlowModeRecord(profileId, sessionKey);
  if (!current?.enabled) return null;
  const documents = extractFlowDocumentsFromText(value);
  const document = documents.at(-1);
  if (!document) return null;
  const targetMapId = executionTarget?.mapId || current.activeMapId;
  const targetMap = current.maps.find((map) => map.id === targetMapId);
  if (!targetMap && current.maps.length > 0) return null;
  if (!targetMap && executionTarget) return null;
  if (targetMap && Number.isFinite(executionTarget?.mapRevision) && targetMap.revision !== executionTarget?.mapRevision) return null;
  try {
    return await setSessionFlowMode(profileId, sessionKey, {
      operation: 'save',
      enabled: true,
      detail: current.detail,
      brief: current.brief,
      mapId: targetMap?.id,
      document,
      expectedMapRevision: targetMap?.revision,
      source: 'agent',
    });
  } catch (error: any) {
    if (error?.statusCode === 404 || error?.statusCode === 409) return null;
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
  const activeMap = mode.maps.find((map) => map.id === mode.activeMapId) || null;
  const mapIndex = mode.maps.map((map) => ({
    id: map.id,
    title: map.title,
    nodeCount: map.nodeCount,
    edgeCount: map.edgeCount,
    active: map.id === mode.activeMapId,
  }));
  return [
    'מצב יצירת זרימה פעיל בסשן הזה.',
    'המטרה: להפוך את המערכת האמיתית למפה חזותית בהירה, נעימה ואמינה בעברית פשוטה ואנושית.',
    `בסשן יש ${mode.maps.length} מפות. המפה הפעילה בלבד היא יעד העבודה הנוכחי: "${activeMap?.title || currentDocument.title}" (mapId: ${activeMap?.id || 'new-map'}).`,
    `אינדקס המפות בסשן: ${JSON.stringify(mapIndex)}. האינדקס ניתן להתמצאות בלבד; אל תשנה מפות אחרות ואל תחזיר כמה מפות באותה תשובה.`,
    `רמת פירוט מבוקשת: ${detailLabel}.`,
    mode.brief ? `דגש מיוחד של המשתמש: ${mode.brief}` : null,
    'בדוק את הקוד, הקונפיגורציה והריצה בפועל לפני קביעה. הפרד במפורש בין רכיב שנמצא בריפו, שירות חיצוני, שירות מנוהל, תשתית או מצב לא ידוע. אל תמציא ודאות; הוסף ראיות של path/url/runtime/note כאשר הן ידועות.',
    'כתוב לכל מודול title קצר, summary של משפט אחד ו-description אנושי שמסביר מה הוא עושה, למה הוא קיים, עם מי הוא מדבר ומה חשוב לדעת עליו.',
    'בנה את המפה כזרימה מכוונת שאפשר לקרוא מהתחלה לסוף: source הוא תמיד הרכיב ששולח/מפעיל/יוזם ו-target הוא הרכיב שמקבל/מופעל. סמן flowRole="entry" לנקודות כניסה אמיתיות, "exit" לסיום או תוצאה אמיתיים, "decision" להסתעפות, ו-"support" למסד נתונים, תור או תשתית שאינם שלב ראשי. השתמש ב-"auto" רק כשאין ודאות.',
    'שמור את הנתיב הראשי קצר וברור והעבר תלות או פריסה משנית ל-edge kind מתאים. אל תחבר כל רכיב לכל רכיב רק כדי להראות תלות עקיפה; כל חץ חייב לתאר מעבר ישיר ואמיתי.',
    'בסוף התשובה חובה להוסיף בלוק יחיד ומלא של JSON תקין בגדר קוד בשם bina-flow. הבלוק הוא snapshot מלא שמחליף את הקודם, לא patch. אין להוסיף הערות בתוך JSON.',
    'הסכימה: {schemaVersion:1,id,title,subtitle,summary,direction:"rtl"|"ltr",layoutVersion:0,groups:[{id,title,description,color:"sky"|"mint"|"violet"|"rose"|"amber"|"slate"}],nodes:[{id,title,summary,description,kind:"system"|"ui"|"api"|"service"|"worker"|"database"|"queue"|"container"|"external"|"file"|"decision"|"person"|"other",ownership:"repository"|"external"|"managed"|"infrastructure"|"unknown",status:"active"|"planned"|"risk"|"unknown",flowRole:"auto"|"entry"|"step"|"decision"|"exit"|"support",groupId:null|string,technology,runtime,repositoryPath,externalUrl,tags:string[],evidence:[{id,kind:"path"|"url"|"runtime"|"note",label,value}],position:null}],edges:[{id,source,target,label,description,kind:"data"|"request"|"event"|"dependency"|"control"|"deploy"|"other"}],updatedAt}. קבע layoutVersion:0 ו-position:null כדי שמנוע הסידור המקצועי של הממשק יבנה שכבות ללא חפיפות.',
    'שמור מזהים קיימים כאשר אותו מודול עדיין קיים. אם המשתמש מבקש להוסיף, להסיר או לשנות מודול — עדכן את ה-snapshot בהתאם. אם הפעולה כוללת גם שינוי קוד, בצע את עבודת הקוד ובסוף עדכן את המפה למה שקיים בפועל.',
    'הזרימה הקנונית של המפה הפעילה (זהו ההקשר המלא והעדכני לעריכה; הפלט שלך יעדכן רק מפה זו):',
    JSON.stringify(currentDocument),
  ].filter(Boolean).join('\n\n');
}
