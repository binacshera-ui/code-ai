import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG, type AppMode, type AppProvider } from './config.js';
import type {
  CodexProfile,
  CodexSessionDetail,
  CodexSessionSummary,
  CodexTimelineEntry,
} from './codexService.js';

type SupportRequestSource = 'ui' | 'api' | 'webhook';

interface SupportTurnRecord {
  id: string;
  createdAt: string;
  source: SupportRequestSource;
  userPrompt: string;
  promptPreview: string;
  compiledEnvelope: string;
  userContext: string | null;
  webhookPayload: string | null;
}

interface SupportSessionRecord {
  sessionKey: string;
  sessionId: string | null;
  profileId: string;
  sourceProfileId: string;
  provider: AppProvider;
  workspaceCwd: string;
  sandboxCwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  turns: SupportTurnRecord[];
}

interface SupportSessionState {
  sessionsByKey: Record<string, SupportSessionRecord>;
}

export interface SupportRequestEnvelopeInput {
  source: SupportRequestSource;
  userPrompt: string;
  userContext?: string | null;
  webhookPayload?: unknown;
  authenticatedUser?: {
    id?: string | null;
    email?: string | null;
    name?: string | null;
  } | null;
}

export interface SupportPromptEnvelope {
  displayPrompt: string;
  compiledPrompt: string;
  promptPreview: string;
  userContext: string | null;
  webhookPayloadText: string | null;
}

const SUPPORT_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'support');
const SUPPORT_STATE_FILE = path.join(SUPPORT_ROOT, 'support-session-state.json');
const SUPPORT_SANDBOX_README = `# code-ai support sandbox

כל קובץ שנוצר כאן נחשב כתוצר sandbox של מצב התמיכה.
אל תערוך מחוץ לתיקייה הזו מתוך מצב התמיכה.
`;

let supportStateLoadPromise: Promise<void> | null = null;
let supportPersistTail: Promise<void> = Promise.resolve();
let supportState: SupportSessionState = {
  sessionsByKey: {},
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function trimPreview(text: string, limit = 140): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function clipLongText(text: string, limit = 24_000): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 1).trimEnd()}\n…`;
}

function serializePayload(value: unknown, limit = 12_000): string | null {
  if (value === undefined) {
    return null;
  }

  try {
    const serialized = typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);
    return clipLongText(serialized, limit);
  } catch {
    return null;
  }
}

function buildSupportSessionKey(profileId: string, sessionKey: string): string {
  return `${profileId}:${sessionKey}`;
}

async function ensureSupportStateLoaded(): Promise<void> {
  if (supportStateLoadPromise) {
    return supportStateLoadPromise;
  }

  supportStateLoadPromise = (async () => {
    try {
      const raw = await fs.readFile(SUPPORT_STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      supportState = {
        sessionsByKey: parsed.sessionsByKey && typeof parsed.sessionsByKey === 'object'
          ? parsed.sessionsByKey as Record<string, SupportSessionRecord>
          : {},
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      supportState = {
        sessionsByKey: {},
      };
    }
  })();

  await supportStateLoadPromise;
}

async function persistSupportState(): Promise<void> {
  supportPersistTail = supportPersistTail.then(async () => {
    await fs.mkdir(path.dirname(SUPPORT_STATE_FILE), { recursive: true });
    await fs.writeFile(SUPPORT_STATE_FILE, JSON.stringify(supportState, null, 2), 'utf-8');
  });

  await supportPersistTail;
}

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

function getProviderDisplayLabel(provider: AppProvider): string {
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'gemini') {
    return 'Gemini';
  }
  return 'Codex';
}

export function isSupportProfile(profile: Pick<CodexProfile, 'mode'> | null | undefined): boolean {
  return profile?.mode === 'support';
}

export function filterProfilesByMode(profiles: CodexProfile[], mode: AppMode): CodexProfile[] {
  return profiles.filter((profile) => (mode === 'support' ? profile.mode === 'support' : profile.mode !== 'support'));
}

export function resolveDefaultProfileForMode(
  profiles: CodexProfile[],
  mode: AppMode,
  provider?: AppProvider
): CodexProfile | null {
  const modeProfiles = filterProfilesByMode(profiles, mode)
    .filter((profile) => (!provider || profile.provider === provider));
  return modeProfiles.find((profile) => profile.defaultProfile) || modeProfiles[0] || null;
}

export async function prepareSupportProfileHome(profile: CodexProfile): Promise<void> {
  if (!isSupportProfile(profile)) {
    return;
  }

  const sourceProfile = getSourceProfile(profile);
  if (!sourceProfile) {
    throw new Error(`Support profile ${profile.id} is missing its source profile binding`);
  }

  await fs.mkdir(profile.codexHome, { recursive: true });
  await fs.mkdir(getProfileHomeRoot(profile), { recursive: true });
  if (profile.sandboxCwd) {
    await fs.mkdir(profile.sandboxCwd, { recursive: true });
    await fs.writeFile(path.join(profile.sandboxCwd, 'README.md'), SUPPORT_SANDBOX_README, 'utf-8').catch(() => undefined);
  }

  if (profile.provider === 'claude') {
    await Promise.all([
      copyFileIfFresh(path.join(getProfileHomeRoot(sourceProfile), '.claude.json'), path.join(getProfileHomeRoot(profile), '.claude.json')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, '.credentials.json'), path.join(profile.codexHome, '.credentials.json')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, 'settings.json'), path.join(profile.codexHome, 'settings.json')),
      copyFileIfFresh(path.join(sourceProfile.codexHome, 'mcp-needs-auth-cache.json'), path.join(profile.codexHome, 'mcp-needs-auth-cache.json')),
    ]);
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
    return;
  }

  await Promise.all([
    copyFileIfFresh(path.join(sourceProfile.codexHome, 'auth.json'), path.join(profile.codexHome, 'auth.json')),
    copyFileIfFresh(path.join(sourceProfile.codexHome, 'config.toml'), path.join(profile.codexHome, 'config.toml')),
    copyFileIfFresh(path.join(sourceProfile.codexHome, 'installation_id'), path.join(profile.codexHome, 'installation_id')),
    copyFileIfFresh(path.join(sourceProfile.codexHome, 'models_cache.json'), path.join(profile.codexHome, 'models_cache.json')),
  ]);
}

export async function prepareAllSupportProfileHomes(): Promise<Set<string>> {
  const failedProfiles = new Set<string>();
  const supportProfiles = CODEX_APP_CONFIG.profiles.filter((profile) => profile.mode === 'support');
  for (const profile of supportProfiles) {
    try {
      await prepareSupportProfileHome(profile);
    } catch (error: any) {
      failedProfiles.add(profile.id);
      console.warn(
        `Skipping support profile ${profile.id} during discovery: ${error?.message || 'unknown error'}`
      );
    }
  }

  return failedProfiles;
}

function buildSupportUserContextText(input: SupportRequestEnvelopeInput): string | null {
  const sections: string[] = [];
  if (input.authenticatedUser) {
    const parts = [
      input.authenticatedUser.name ? `name=${input.authenticatedUser.name}` : null,
      input.authenticatedUser.email ? `email=${input.authenticatedUser.email}` : null,
      input.authenticatedUser.id ? `id=${input.authenticatedUser.id}` : null,
    ].filter(Boolean);
    if (parts.length > 0) {
      sections.push(`Authenticated operator: ${parts.join(', ')}`);
    }
  }

  if (typeof input.userContext === 'string' && input.userContext.trim()) {
    sections.push(input.userContext.trim());
  }

  return sections.length > 0 ? sections.join('\n') : null;
}

function buildSupportPolicyText(profile: CodexProfile): string {
  const providerLabel = getProviderDisplayLabel(profile.provider);
  const sandboxPath = profile.sandboxCwd || path.join(SUPPORT_ROOT, 'sandbox', profile.provider, profile.id);

  return [
    `אתה סוכן תמיכה אנושי-למראה של Bina Cshera 2.0, שרץ כרגע דרך ${providerLabel} בתוך סביבת העבודה code-ai.`,
    'מפת השירותים העסקית: שיחה, עריכה, קוד, תמונות, תמלול, הקלדה, מידע. יש גם שירותים פנימיים כגון help, maps, courses, search, indexing ו-code.',
    'המטרה שלך היא לפתור פניות תמיכה אמיתיות למשתמשים: להבין מי המשתמש, לאסוף הקשר מהמערכות הרלוונטיות, לבדוק קוד/לוגים/היסטוריות/MAKE2, ולהחזיר תשובה אנושית ותכליתית.',
    'שלבי הפתיחה המחייבים בכל פנייה: 1. לזהות את המשתמש/היישויות הרלוונטיות מתוך ההודעה או הוובהוק. 2. לכתוב בקצרה מה אתה עומד לבדוק. 3. לאסוף את המידע החסר לפני מסקנות. 4. רק אז לענות או לפעול.',
    `מותר לך לחקור ולקרוא בכל פרויקט בינה כשרה, אבל אסור לך לערוך, למחוק, לדרוס או ליצור קבצים מחוץ לארגז החול הזה: ${sandboxPath}. אם צריך לכתוב קובץ עזר, פלט, patch, דו"ח או reproduction — זה רק בתוך הארגז הזה.`,
    'אם אתה מגלה שהפעולה הבאה מחייבת כתיבת קבצים מחוץ לארגז החול, עצור, הסבר למשתמש מה צריך לעשות, והצע את ה-output כתוכן טקסטואלי בלבד.',
    `כל מה שקורה כאן נשמר במצב התמיכה הפנימי של code-ai, ולא במצב הסוכנים הרגיל של ${providerLabel}.`,
  ].join('\n');
}

export function buildSupportPromptEnvelope(
  profile: CodexProfile,
  input: SupportRequestEnvelopeInput
): SupportPromptEnvelope {
  const policyText = buildSupportPolicyText(profile);
  const userContext = buildSupportUserContextText(input);
  const webhookPayloadText = serializePayload(input.webhookPayload);
  const promptPreview = trimPreview(input.userPrompt || 'פניית תמיכה');
  const sections = [
    'Support request envelope',
    `Provider: ${getProviderDisplayLabel(profile.provider)}`,
    `Workspace root: ${profile.workspaceCwd}`,
    `Sandbox path: ${profile.sandboxCwd || ''}`,
    `Source: ${input.source}`,
    userContext ? `Known user / operator context:\n${userContext}` : null,
    webhookPayloadText ? `Webhook payload:\n${webhookPayloadText}` : null,
    `Support operating rules:\n${policyText}`,
    `User request:\n${input.userPrompt.trim()}`,
  ].filter(Boolean);

  return {
    displayPrompt: input.userPrompt.trim(),
    compiledPrompt: clipLongText(sections.join('\n\n')),
    promptPreview,
    userContext,
    webhookPayloadText,
  };
}

export async function recordSupportTurnRequest(options: {
  profile: CodexProfile;
  sessionKey: string;
  source: SupportRequestSource;
  envelope: SupportPromptEnvelope;
}): Promise<void> {
  if (!isSupportProfile(options.profile)) {
    return;
  }

  await ensureSupportStateLoaded();

  const recordKey = buildSupportSessionKey(options.profile.id, options.sessionKey);
  const now = nowIso();
  const existing = supportState.sessionsByKey[recordKey];
  const supportRecord: SupportSessionRecord = existing || {
    sessionKey: options.sessionKey,
    sessionId: options.sessionKey.startsWith('draft:') ? null : options.sessionKey,
    profileId: options.profile.id,
    sourceProfileId: options.profile.sourceProfileId || options.profile.id,
    provider: options.profile.provider,
    workspaceCwd: options.profile.workspaceCwd,
    sandboxCwd: options.profile.sandboxCwd || '',
    createdAt: now,
    updatedAt: now,
    title: options.envelope.promptPreview || 'פניית תמיכה',
    turns: [],
  };

  supportRecord.updatedAt = now;
  if (!supportRecord.title) {
    supportRecord.title = options.envelope.promptPreview || 'פניית תמיכה';
  }
  supportRecord.turns.push({
    id: `${options.sessionKey}-support-turn-${supportRecord.turns.length}`,
    createdAt: now,
    source: options.source,
    userPrompt: options.envelope.displayPrompt,
    promptPreview: options.envelope.promptPreview,
    compiledEnvelope: options.envelope.compiledPrompt,
    userContext: options.envelope.userContext,
    webhookPayload: options.envelope.webhookPayloadText,
  });

  supportState.sessionsByKey[recordKey] = supportRecord;
  await persistSupportState();
}

export async function rebindSupportSessionRecord(
  profileId: string,
  fromSessionKey: string,
  toSessionKey: string
): Promise<void> {
  await ensureSupportStateLoaded();

  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) {
    return;
  }

  const fromKey = buildSupportSessionKey(profileId, fromSessionKey);
  const toKey = buildSupportSessionKey(profileId, toSessionKey);
  const existing = supportState.sessionsByKey[fromKey];
  if (!existing) {
    return;
  }

  const rebound: SupportSessionRecord = {
    ...existing,
    sessionKey: toSessionKey,
    sessionId: toSessionKey,
    updatedAt: nowIso(),
  };

  supportState.sessionsByKey[toKey] = rebound;
  delete supportState.sessionsByKey[fromKey];
  await persistSupportState();
}

export async function getSupportSessionRecord(
  profileId: string,
  sessionKey: string
): Promise<SupportSessionRecord | null> {
  await ensureSupportStateLoaded();
  return supportState.sessionsByKey[buildSupportSessionKey(profileId, sessionKey)] || null;
}

function normalizeSupportTimeline(
  timeline: CodexTimelineEntry[],
  turns: SupportTurnRecord[]
): CodexTimelineEntry[] {
  if (turns.length === 0) {
    return timeline;
  }

  const nextTimeline: CodexTimelineEntry[] = [];
  let turnIndex = 0;

  for (const entry of timeline) {
    if (
      turnIndex < turns.length
      && entry.entryType === 'message'
      && entry.role === 'user'
      && typeof entry.text === 'string'
    ) {
      const turn = turns[turnIndex]!;
      nextTimeline.push({
        ...entry,
        text: turn.userPrompt,
      });
      nextTimeline.push({
        id: `${entry.id}-support-envelope`,
        entryType: 'tool',
        timestamp: entry.timestamp,
        toolName: 'support-envelope',
        title: 'מה נשלח לנקודת הקצה',
        subtitle: turn.source === 'webhook' ? 'Webhook support request' : 'Support request envelope',
        text: turn.compiledEnvelope,
      });
      turnIndex += 1;
      continue;
    }

    nextTimeline.push(entry);
  }

  return nextTimeline;
}

function timelineMessagesFromEntries(timeline: CodexTimelineEntry[]) {
  return timeline
    .filter((entry) => entry.entryType === 'message' && entry.role && entry.kind && typeof entry.text === 'string')
    .map((entry) => ({
      id: entry.id,
      role: entry.role!,
      kind: entry.kind!,
      text: entry.text!,
      timestamp: entry.timestamp,
    }));
}

export async function decorateSupportSessionSummary(
  profile: CodexProfile,
  summary: CodexSessionSummary
): Promise<CodexSessionSummary> {
  if (!isSupportProfile(profile)) {
    return summary;
  }

  const record = await getSupportSessionRecord(profile.id, summary.id);
  if (!record) {
    return summary;
  }

  const firstTurn = record.turns[0];
  const lastTurn = record.turns[record.turns.length - 1];

  return {
    ...summary,
    title: record.title || firstTurn?.promptPreview || summary.title,
    preview: lastTurn?.promptPreview || summary.preview,
    startPreview: firstTurn?.promptPreview || summary.startPreview,
    endPreview: lastTurn?.promptPreview || summary.endPreview,
  };
}

export async function decorateSupportSessionDetail(
  profile: CodexProfile,
  detail: CodexSessionDetail
): Promise<CodexSessionDetail> {
  if (!isSupportProfile(profile)) {
    return detail;
  }

  const record = await getSupportSessionRecord(profile.id, detail.id);
  if (!record) {
    return detail;
  }

  const normalizedTimeline = normalizeSupportTimeline(detail.timeline, record.turns);
  const normalizedMessages = normalizedTimeline.filter((entry) => entry.entryType === 'message').length;

  return {
    ...detail,
    title: record.title || detail.title,
    preview: record.turns[record.turns.length - 1]?.promptPreview || detail.preview,
    startPreview: record.turns[0]?.promptPreview || detail.startPreview,
    endPreview: record.turns[record.turns.length - 1]?.promptPreview || detail.endPreview,
    messages: timelineMessagesFromEntries(normalizedTimeline),
    timeline: [
      {
        id: `${detail.id}-support-mode`,
        entryType: 'status',
        timestamp: record.createdAt,
        status: 'support-mode',
        title: 'מצב תמיכה פנימי',
        subtitle: `Workspace: ${record.workspaceCwd}`,
        text: `Sandbox: ${record.sandboxCwd}`,
      },
      ...normalizedTimeline,
    ],
    messageCount: normalizedMessages,
    totalTimelineEntries: normalizedTimeline.length + 1,
    timelineWindowEnd: normalizedTimeline.length + 1,
  };
}

export async function normalizeSupportSessionForOperations(
  profile: CodexProfile,
  detail: CodexSessionDetail
): Promise<CodexSessionDetail> {
  if (!isSupportProfile(profile)) {
    return detail;
  }

  const record = await getSupportSessionRecord(profile.id, detail.id);
  if (!record) {
    return detail;
  }

  const normalizedTimeline = normalizeSupportTimeline(detail.timeline, record.turns)
    .filter((entry) => !(entry.entryType === 'tool' && entry.toolName === 'support-envelope'));

  return {
    ...detail,
    messages: timelineMessagesFromEntries(normalizedTimeline),
    timeline: normalizedTimeline,
    totalTimelineEntries: normalizedTimeline.length,
    timelineWindowEnd: normalizedTimeline.length,
  };
}

export function resolveSupportProfileSelection(
  profileId: string | undefined,
  provider: AppProvider | undefined
): CodexProfile {
  if (profileId) {
    const direct = CODEX_APP_CONFIG.profiles.find((candidate) => candidate.id === profileId);
    if (direct && direct.mode === 'support') {
      return direct as CodexProfile;
    }
  }

  const filtered = CODEX_APP_CONFIG.profiles.filter((candidate) => (
    candidate.mode === 'support'
    && (!provider || candidate.provider === provider)
  ));
  const profile = filtered.find((candidate) => candidate.defaultProfile) || filtered[0];
  if (!profile) {
    throw new Error('No support profile is configured for the requested provider');
  }

  return profile as CodexProfile;
}
