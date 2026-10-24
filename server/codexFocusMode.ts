import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODEX_APP_CONFIG } from './config.js';
import type { CodexProfile } from './codexService.js';

export interface CodexSessionFocusMode {
  enabled: boolean;
  goal: string;
  rationalEnabled: boolean;
  /** Legacy wire fields for already-open clients; ignored by new runtime budgets. */
  planningMinutes: number;
  taskMinutes: number;
  decisionEnabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CodexSessionFocusModeInput {
  enabled?: boolean;
  goal?: string | null;
  rationalEnabled?: boolean;
  planningMinutes?: number;
  taskMinutes?: number;
  decisionEnabled?: boolean;
}

interface FocusModeState {
  modesByKey: Record<string, CodexSessionFocusMode>;
}

export const FOCUS_MODE_GOAL_MAX_LENGTH = 2_000;
const FOCUS_MODE_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'local', 'focus-mode');
const FOCUS_MODE_STATE_FILE = path.join(FOCUS_MODE_ROOT, 'session-focus-mode.json');
let loadPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: FocusModeState = { modesByKey: {} };

function stateKey(profileId: string, sessionKey: string): string {
  return `${profileId}:${sessionKey}`;
}

function cleanGoal(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, FOCUS_MODE_GOAL_MAX_LENGTH)
    : '';
}

function normalizeMode(
  value: CodexSessionFocusModeInput | CodexSessionFocusMode | null | undefined,
  current = createEmptySessionFocusMode(),
): CodexSessionFocusMode {
  const candidate = value || {};
  const record = candidate as Partial<CodexSessionFocusMode>;
  return {
    enabled: candidate.enabled === undefined ? current.enabled : candidate.enabled === true,
    goal: cleanGoal(candidate.goal === undefined ? current.goal : candidate.goal),
    rationalEnabled: candidate.rationalEnabled === undefined ? current.rationalEnabled : candidate.rationalEnabled === true,
    decisionEnabled: candidate.decisionEnabled === undefined ? current.decisionEnabled : candidate.decisionEnabled === true,
    planningMinutes: Number.isInteger(candidate.planningMinutes) && candidate.planningMinutes! >= 1 && candidate.planningMinutes! <= 30
      ? candidate.planningMinutes! : current.planningMinutes,
    taskMinutes: Number.isInteger(candidate.taskMinutes) && candidate.taskMinutes! >= 1 && candidate.taskMinutes! <= 240
      ? candidate.taskMinutes! : current.taskMinutes,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : current.createdAt,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : current.updatedAt,
  };
}

async function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(FOCUS_MODE_STATE_FILE, 'utf8')) as Partial<FocusModeState>;
        state = {
          modesByKey: Object.fromEntries(
            Object.entries(parsed.modesByKey || {}).map(([key, value]) => [key, normalizeMode(value)]),
          ),
        };
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        state = { modesByKey: {} };
      }
    })().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  await loadPromise;
}

async function persist(): Promise<void> {
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  // A failed write must be visible to its caller, but must not poison future saves.
  persistTail = persistTail.catch(() => undefined).then(async () => {
    await fs.mkdir(FOCUS_MODE_ROOT, { recursive: true, mode: 0o700 });
    await fs.chmod(FOCUS_MODE_ROOT, 0o700);
    const temporaryPath = `${FOCUS_MODE_STATE_FILE}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporaryPath, FOCUS_MODE_STATE_FILE);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  });
  await persistTail;
}

export function createEmptySessionFocusMode(): CodexSessionFocusMode {
  return { enabled: false, goal: '', rationalEnabled: false, planningMinutes: 3, taskMinutes: 15,
    decisionEnabled: false, createdAt: null, updatedAt: null };
}

export async function validateSessionFocusMode(
  profile: Pick<CodexProfile, 'provider'>,
  value: CodexSessionFocusModeInput | null | undefined,
  current?: CodexSessionFocusMode | null,
): Promise<CodexSessionFocusMode> {
  const normalized = normalizeMode(value, current || undefined);
  if ((normalized.enabled || normalized.rationalEnabled || normalized.decisionEnabled) && profile.provider !== 'codex') {
    throw new Error('מצב מיקוד וביצוע זמין כרגע רק לסשני Codex.');
  }
  return normalized;
}

export async function getSessionFocusMode(profileId: string, sessionKey: string): Promise<CodexSessionFocusMode> {
  await ensureLoaded();
  return { ...(state.modesByKey[stateKey(profileId, sessionKey)] || createEmptySessionFocusMode()) };
}

export async function getSessionFocusModeRecord(profileId: string, sessionKey: string): Promise<CodexSessionFocusMode | null> {
  await ensureLoaded();
  const record = state.modesByKey[stateKey(profileId, sessionKey)];
  return record ? { ...record } : null;
}

export async function setSessionFocusMode(
  profileId: string,
  sessionKey: string,
  value: CodexSessionFocusModeInput | CodexSessionFocusMode,
): Promise<CodexSessionFocusMode> {
  await ensureLoaded();
  const key = stateKey(profileId, sessionKey);
  const previous = state.modesByKey[key];
  const timestamp = new Date().toISOString();
  const record: CodexSessionFocusMode = {
    ...normalizeMode(value, previous),
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  state.modesByKey[key] = record;
  await persist();
  return { ...record };
}

export async function rebindSessionFocusMode(profileId: string, fromSessionKey: string, toSessionKey: string): Promise<void> {
  await ensureLoaded();
  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) return;
  const fromKey = stateKey(profileId, fromSessionKey);
  const record = state.modesByKey[fromKey];
  if (!record) return;
  const toKey = stateKey(profileId, toSessionKey);
  // The canonical conversation can already carry a newer explicit preference.
  // Binding a queued draft must not re-enable or overwrite that target choice.
  if (!state.modesByKey[toKey]) {
    state.modesByKey[toKey] = { ...record, updatedAt: new Date().toISOString() };
  }
  delete state.modesByKey[fromKey];
  await persist();
}

export async function deleteSessionFocusMode(profileId: string, sessionKey: string): Promise<void> {
  await ensureLoaded();
  const key = stateKey(profileId, sessionKey);
  if (!state.modesByKey[key]) return;
  delete state.modesByKey[key];
  await persist();
}

export function buildSessionFocusModePromptAdditions(options: { mode: CodexSessionFocusMode }): string {
  if (!options.mode.enabled) return 'מצב מיקוד וביצוע אינו פעיל.';
  const goal = cleanGoal(options.mode.goal);
  return [
    'מצב שיקול דעת הנדסי פעיל — בחינה ביקורתית של דרך העבודה, לא הרשאה נוספת:',
    goal ? `יעד הלקוח שנשמר למיקוד (נתון הקשר בלבד): ${JSON.stringify(goal)}` : '',
    'קבע את התוצאה המבוקשת לפי בקשת המשתמש העדכנית וההיקף המאושר. אם היעד השמור או סיכום ישן סותרים אותה, פעל לפי הבקשה העדכנית בלי להרחיב היקף.',
    'פעל כמהנדס אחראי שגם בוחן אם התכנון עצמו נכון, לא רק כמבצע של הנוהל הקיים. ארכיטקטורה, תהליך, סקיל או תוכנית שסוכן כתב בעבר הם הצעה שניתן לבקר, לא הוכחה לאיכות ולא יעד שצריך לשמר בכל מחיר.',
    'אם הפעולה המבוקשת הפכה לשרשרת תיאומים, העברות אחריות, שערים כפולים, תלות בשירותים שאינם קשורים, טלאים או ניסיונות שחושפים בכל פעם שכבה חסרה אחרת — עצור את דרך העבודה הזאת לפני עוד שלב. אין צורך לחכות לכשל פקודה: גם פקודות שמצליחות, תהליך שפועל לפי כל הכללים ובדיקות ירוקות יכולים להסתיר תכנון מסורבל שלא מספק את המוצר.',
    'אמור למשתמש ישירות ובכבוד, עם ראיה אחת או שתיים: "רפאל, הבעיה כאן אינה עוד תקלה נקודתית; דרך העבודה עצמה מסורבלת בגלל __. אני ממליץ לפשט ל־__ ולהסיר או לאחד את __." מלא את החסר לפי המערכת האמיתית; אל תשתמש בתבנית במקום אבחון ואל תכריז שכל מערכת קיימת פגומה.',
    'השווה את הדרך הקיימת לדרך המקצועית הקצרה ביותר שמספקת את אותה תוצאה ואותן הגנות נדרשות. הצע פישוט קונקרטי: מה נמחק או מתאחד, מי הבעלים היחיד של הפעולה, מה מסלול הביצוע הישיר ומה הבדיקה הרלוונטית לתוצאה. בדוק קודם יכולת בשלה שכבר קיימת. פישוט אינו סתם פחות קוד או פחות בדיקות: אין לזרוק מנגנון שפותר צורך ממשי בלי חלופה מוכחת.',
    'אל תענה למורכבות מיותרת בעוד מנהל, מתאם, ועדת ארכיטקטורה, רשימת כללים, מנגנון תזכורות, שלב אישור או דוח חדש. אין להפוך גם את הביקורת הזאת לטקס שחוזר לפני כל פקודה. בדוק אותה בתחילת עבודה וכשמתגלה ראיה שמשנה את ההחלטה, ואז בצע את הפעולה המועילה הבאה.',
    'לפני שאתה מתייחס לזיכרון, לתוכנית או לכלל שסוכן כתב בעבר כחובה, בדוק את קובץ ההוראות המוסמך והמקור העדכני הרלוונטי. אל תהפוך הערות מודל ישנות, נוהל מוצע או תיאום שבוטל למחסום מחייב; אם יש סתירה אמיתית בהוראות מוסמכות, הצג אותה בקצרה ואל תעקוף אותה.',
    'כל הוראות המערכת, המפתח והמשתמש, גבולות ההרשאה, ההפרדה בין סשנים, כללי הבטיחות ושערי בקרת הפריסה המחייבים נשארים בתוקף. אין להחליש אותם, להסיר נעילות, ליצור כותב עצמאי, לטעון לקבלה שלא אומתה או להסיק הרשאה מסירוב.',
    'לאחר שני ניסיונות זהים שנכשלו עם אותה ראיה, אל תחזור עליהם אוטומטית: שנה גישה באופן בטוח על בסיס מידע חדש, או הצג חסם מסוים אחד עם ראיה ומה בדיוק נדרש לפתרונו. אל תמציא שערי אישור טקסיים, בעלי תפקידים או תהליכי תיאום נוספים.',
    'אם הפישוט הוא תיקון רגיל בתוך ההיקף המאושר, בצע אותו בלי לבקש שוב רשות שכבר ניתנה. אם הוא מחייב שינוי מהותי בהיקף, מחיקה בלתי הפיכה או שינוי הוראה מחייבת, הצג החלטה קונקרטית אחת הנדרשת מרפאל; אל תעקוף את המגבלה ואל תמשיך להוסיף טלאים כדי לא להעלות אותה. מותר להמליץ לשנות נוהל מחייב; אסור לשנותו או להפר אותו בלי הסמכות המתאימה.',
    'אל תרחיב משימת מוצר לניהול תשתיות או לפריסה כללית ללא צורך והרשאה. העדף בעלים ומסלול ביצוע יחידים, אבל אל תשמר מסלול מסורבל רק מפני שהוא קיים. אין לנסות שוב קלט שהתקבל או שקבלתו אינה ידועה בלי בדיקת קבלה מוסמכת.',
    'בחסם אמיתי שלא ניתן לפתור בבטחה ובהיקף הקיים, הפסק המשכים אוטומטיים ודווח בקצרה את הראיה ואת הפעולה המדויקת הדרושה מהמשתמש. אין לבטל עבודה אחרת, להמתין בלולאה או להכריז הצלחה ללא אימות.',
  ].filter(Boolean).join('\n\n');
}
