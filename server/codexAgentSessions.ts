import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG, type AppProvider } from './config.js';
import type { CodexProfile } from './codexService.js';

export type AgentSessionStatus = 'draft' | 'planned' | 'approved' | 'running' | 'completed' | 'failed';
export type AgentSessionLinkKind = 'planner' | 'agent';
export type AgentRuntimeStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentSessionAgentPlan {
  id: string;
  name: string;
  provider: AppProvider;
  role: string;
  objective: string;
  scopePaths: string[];
  dependsOn: string[];
  notes: string | null;
  instructionPath: string;
  statusPath: string;
}

export interface AgentSessionAgentRuntime {
  id: string;
  name: string;
  provider: AppProvider;
  runtimeStatus: AgentRuntimeStatus;
  linkedSessionId: string | null;
  queueItemId: string | null;
  updatedAt: string | null;
  lastMessage: string | null;
  lastError: string | null;
}

export interface AgentSessionPlan {
  title: string;
  goal: string;
  sharedStatusPath: string;
  eventsPath: string;
  coordinationRules: string[];
  agents: AgentSessionAgentPlan[];
  runtimeAgents?: AgentSessionAgentRuntime[];
}

export interface AgentSessionRecord {
  id: string;
  sourceProfileId: string;
  sourceProvider: AppProvider;
  plannerProvider: AppProvider;
  cwd: string;
  title: string;
  goal: string;
  status: AgentSessionStatus;
  topicId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  launchedAt: string | null;
  rootPath: string;
  planPath: string;
  sharedStatusPath: string;
  eventsPath: string;
  plannerSessionId: string | null;
  plannerProfileId: string | null;
  plan: AgentSessionPlan | null;
}

export interface AgentSessionLinkRecord {
  sessionId: string;
  agentSessionId: string;
  sourceProfileId: string;
  profileId: string;
  provider: AppProvider;
  kind: AgentSessionLinkKind;
  agentId: string | null;
  createdAt: string;
}

interface AgentSessionState {
  sessionsById: Record<string, AgentSessionRecord>;
  sessionLinksBySessionId: Record<string, AgentSessionLinkRecord>;
}

const AGENT_SESSIONS_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'agent-sessions');
const AGENT_SESSIONS_DATA_ROOT = path.join(AGENT_SESSIONS_ROOT, 'sessions');
const AGENT_SESSIONS_STATE_FILE = path.join(AGENT_SESSIONS_ROOT, 'state.json');

let loadPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: AgentSessionState = {
  sessionsById: {},
  sessionLinksBySessionId: {},
};

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function normalizeText(value: unknown, fallback: string, limit = 200): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, limit);
}

function normalizeMultilineText(value: unknown, fallback = '', limit = 8_000): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, limit);
}

function normalizePathList(value: unknown, fallbackRoot: string): string[] {
  if (!Array.isArray(value)) {
    return [fallbackRoot];
  }

  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    deduped.add(path.resolve(trimmed));
  }

  if (deduped.size === 0) {
    deduped.add(fallbackRoot);
  }

  return [...deduped];
}

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    deduped.add(trimmed);
  }

  return [...deduped];
}

function cloneAgent(agent: AgentSessionAgentPlan): AgentSessionAgentPlan {
  return {
    ...agent,
    scopePaths: [...agent.scopePaths],
    dependsOn: [...agent.dependsOn],
  };
}

function clonePlan(plan: AgentSessionPlan): AgentSessionPlan {
  return {
    ...plan,
    coordinationRules: [...plan.coordinationRules],
    agents: plan.agents.map(cloneAgent),
    runtimeAgents: Array.isArray(plan.runtimeAgents) ? plan.runtimeAgents.map((agent) => ({ ...agent })) : [],
  };
}

function cloneRecord(record: AgentSessionRecord): AgentSessionRecord {
  return {
    ...record,
    plan: record.plan ? clonePlan(record.plan) : null,
  };
}

function cloneLink(record: AgentSessionLinkRecord): AgentSessionLinkRecord {
  return { ...record };
}

function defaultCoordinationRules(sharedStatusPath: string): string[] {
  return [
    `לפני כל פעולה משמעותית יש לקרוא את ${sharedStatusPath}`,
    `אחרי כל פעולה משמעותית יש לעדכן את ${sharedStatusPath}`,
    'יש להתייחס לעדכוני סוכנים אחרים כמקור אמת לתיאום עבודה',
    'אם צעד של סוכן אחר משנה את ההנחות שלך, עליך להסתגל ולעדכן את מצבך בהתאם',
  ];
}

function buildAgentSessionPaths(id: string) {
  const rootPath = path.join(AGENT_SESSIONS_DATA_ROOT, sanitizeToken(id));
  return {
    rootPath,
    planPath: path.join(rootPath, 'agent-plan.json'),
    sharedStatusPath: path.join(rootPath, 'shared-status.json'),
    eventsPath: path.join(rootPath, 'events.jsonl'),
    agentsRoot: path.join(rootPath, 'agents'),
  };
}

function normalizeAgentPlan(
  record: AgentSessionRecord,
  rawPlan: unknown
): AgentSessionPlan {
  const candidate = (rawPlan && typeof rawPlan === 'object')
    ? rawPlan as Record<string, unknown>
    : {};
  const paths = buildAgentSessionPaths(record.id);
  const agentsRoot = paths.agentsRoot;

  const rawAgents = Array.isArray(candidate.agents) ? candidate.agents : [];
  const agents = rawAgents.map((rawAgent, index) => {
    const item = rawAgent && typeof rawAgent === 'object'
      ? rawAgent as Record<string, unknown>
      : {};
    const baseName = normalizeText(item.name, `סוכן ${index + 1}`, 80);
    const agentId = normalizeText(item.id, sanitizeToken(baseName).toLowerCase() || `agent-${index + 1}`, 80)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-');
    const provider = item.provider === 'claude' || item.provider === 'gemini' ? item.provider : 'codex';
    const role = normalizeText(item.role, baseName, 160);
    const objective = normalizeMultilineText(item.objective, record.goal, 3000);
    const notes = normalizeMultilineText(item.notes, '', 3000) || null;
    const scopePaths = normalizePathList(item.scopePaths, record.cwd);
    const dependsOn = normalizeIdList(item.dependsOn);
    const agentDir = path.join(agentsRoot, sanitizeToken(agentId));
    return {
      id: agentId,
      name: baseName,
      provider,
      role,
      objective,
      scopePaths,
      dependsOn,
      notes,
      instructionPath: path.join(agentDir, 'instructions.md'),
      statusPath: path.join(agentDir, 'status.json'),
    } satisfies AgentSessionAgentPlan;
  });

  if (agents.length === 0) {
    const fallbackAgentDir = path.join(agentsRoot, 'lead-agent');
    agents.push({
      id: 'lead-agent',
      name: 'Lead Agent',
      provider: record.sourceProvider,
      role: 'חלוקת עבודה וביצוע',
      objective: record.goal,
      scopePaths: [record.cwd],
      dependsOn: [],
      notes: null,
      instructionPath: path.join(fallbackAgentDir, 'instructions.md'),
      statusPath: path.join(fallbackAgentDir, 'status.json'),
    });
  }

  return {
    title: normalizeText(candidate.title, record.title, 160),
    goal: normalizeMultilineText(candidate.goal, record.goal, 4000),
    sharedStatusPath: typeof candidate.sharedStatusPath === 'string' && candidate.sharedStatusPath.trim()
      ? path.resolve(candidate.sharedStatusPath)
      : paths.sharedStatusPath,
    eventsPath: typeof candidate.eventsPath === 'string' && candidate.eventsPath.trim()
      ? path.resolve(candidate.eventsPath)
      : paths.eventsPath,
    coordinationRules: Array.isArray(candidate.coordinationRules)
      ? candidate.coordinationRules
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
      : defaultCoordinationRules(paths.sharedStatusPath),
    agents,
  };
}

async function ensureLoaded() {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    try {
      const raw = await fs.readFile(AGENT_SESSIONS_STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AgentSessionState>;
      const sessionsById = parsed.sessionsById && typeof parsed.sessionsById === 'object'
        ? parsed.sessionsById as Record<string, AgentSessionRecord>
        : {};
      const sessionLinksBySessionId = parsed.sessionLinksBySessionId && typeof parsed.sessionLinksBySessionId === 'object'
        ? parsed.sessionLinksBySessionId as Record<string, AgentSessionLinkRecord>
        : {};
      state = {
        sessionsById,
        sessionLinksBySessionId,
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      state = {
        sessionsById: {},
        sessionLinksBySessionId: {},
      };
    }
  })();

  await loadPromise;
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(AGENT_SESSIONS_STATE_FILE), { recursive: true });
    await fs.writeFile(AGENT_SESSIONS_STATE_FILE, snapshot, 'utf-8');
  });
  await persistTail;
}

async function appendAgentSessionEvent(agentSessionId: string, event: Record<string, unknown>) {
  const record = state.sessionsById[agentSessionId];
  if (!record) {
    return;
  }

  await fs.mkdir(path.dirname(record.eventsPath), { recursive: true });
  await fs.appendFile(record.eventsPath, `${JSON.stringify({ at: nowIso(), ...event })}\n`, 'utf-8');
}

function buildSharedStatusDocument(record: AgentSessionRecord, plan: AgentSessionPlan) {
  return {
    agentSessionId: record.id,
    title: plan.title,
    goal: plan.goal,
    status: record.status,
    updatedAt: record.updatedAt,
    lastUpdatedBy: null,
    coordinationRules: plan.coordinationRules,
    agents: plan.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      role: agent.role,
      objective: agent.objective,
      scopePaths: agent.scopePaths,
      dependsOn: agent.dependsOn,
      statusPath: agent.statusPath,
      instructionPath: agent.instructionPath,
      runtimeStatus: plan.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.runtimeStatus || 'pending',
      linkedSessionId: plan.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.linkedSessionId || null,
      queueItemId: plan.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.queueItemId || null,
      updatedAt: plan.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.updatedAt || null,
      lastMessage: plan.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.lastMessage || null,
      lastError: plan.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.lastError || null,
    })),
    notes: [],
  };
}

function buildAgentInstructionDocument(record: AgentSessionRecord, plan: AgentSessionPlan, agent: AgentSessionAgentPlan): string {
  const dependencyNames = agent.dependsOn
    .map((dependencyId) => plan.agents.find((candidate) => candidate.id === dependencyId)?.name || dependencyId)
    .filter(Boolean);

  return [
    `# Agent Session ${record.title}`,
    '',
    `Agent session id: ${record.id}`,
    `Agent id: ${agent.id}`,
    `Agent name: ${agent.name}`,
    `Provider: ${agent.provider}`,
    `Role: ${agent.role}`,
    '',
    '## Mission',
    agent.objective,
    '',
    '## Shared coordination',
    `Shared status file: ${plan.sharedStatusPath}`,
    `Agent status file: ${agent.statusPath}`,
    'Before every major step, read the shared status file.',
    'After every major step, update the shared status file and your own status file.',
    'If another agent changed assumptions that affect your work, adapt immediately before continuing.',
    'Perform one substantial iteration now, update coordination files, summarize your state, and then stop.',
    'If you are blocked by another agent, record that blocked state explicitly and stop instead of waiting forever.',
    '',
    '## Access policy',
    'You have full project access, including secrets and service credentials available in the workspace.',
    'You may use any internal service credentials that already exist in the repository or adjacent secret stores when needed for the task.',
    'Do not wait for approval prompts. Execute decisively, but always keep the shared status file up to date.',
    '',
    '## Relevant paths',
    ...agent.scopePaths.map((scopePath) => `- ${scopePath}`),
    '',
    dependencyNames.length > 0 ? '## Dependencies' : '',
    ...dependencyNames.map((dependencyName) => `- ${dependencyName}`),
    dependencyNames.length > 0 ? '' : '',
    agent.notes ? '## Notes' : '',
    agent.notes || '',
  ].filter(Boolean).join('\n');
}

export async function createAgentSessionDraft(input: {
  sourceProfile: CodexProfile;
  cwd: string;
  title: string;
  goal: string;
  plannerProvider: AppProvider;
  topicId?: string | null;
}): Promise<AgentSessionRecord> {
  await ensureLoaded();
  const id = randomUUID();
  const paths = buildAgentSessionPaths(id);
  const record: AgentSessionRecord = {
    id,
    sourceProfileId: input.sourceProfile.id,
    sourceProvider: input.sourceProfile.provider,
    plannerProvider: input.plannerProvider,
    cwd: path.resolve(input.cwd),
    title: normalizeText(input.title, 'סשן סוכנים'),
    goal: normalizeMultilineText(input.goal, ''),
    status: 'draft',
    topicId: input.topicId?.trim() || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    approvedAt: null,
    launchedAt: null,
    rootPath: paths.rootPath,
    planPath: paths.planPath,
    sharedStatusPath: paths.sharedStatusPath,
    eventsPath: paths.eventsPath,
    plannerSessionId: null,
    plannerProfileId: null,
    plan: null,
  };

  await fs.mkdir(paths.agentsRoot, { recursive: true });
  await fs.writeFile(paths.eventsPath, '', 'utf-8');
  state.sessionsById[id] = record;
  await persistState();
  await appendAgentSessionEvent(id, { type: 'agent-session-created', sourceProfileId: input.sourceProfile.id });
  return cloneRecord(record);
}

export async function listAgentSessionRecords(sourceProfileId: string, cwd?: string | null): Promise<AgentSessionRecord[]> {
  await ensureLoaded();
  return Object.values(state.sessionsById)
    .filter((record) => record.sourceProfileId === sourceProfileId && (!cwd || record.cwd === path.resolve(cwd)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(cloneRecord);
}

export async function getAgentSessionRecord(agentSessionId: string): Promise<AgentSessionRecord | null> {
  await ensureLoaded();
  const record = state.sessionsById[agentSessionId];
  return record ? cloneRecord(record) : null;
}

export async function saveAgentSessionPlan(
  agentSessionId: string,
  rawPlan: unknown,
  options: {
    plannerSessionId?: string | null;
    plannerProfileId?: string | null;
  } = {}
): Promise<AgentSessionRecord> {
  await ensureLoaded();
  const record = state.sessionsById[agentSessionId];
  if (!record) {
    throw new Error('Agent session was not found');
  }

  const plan = normalizeAgentPlan(record, rawPlan);
  const runtimeAgents = plan.agents.map((agent) => {
    const existing = record.plan?.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id);
    return {
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      runtimeStatus: existing?.runtimeStatus || 'pending',
      linkedSessionId: existing?.linkedSessionId || null,
      queueItemId: existing?.queueItemId || null,
      updatedAt: existing?.updatedAt || null,
      lastMessage: existing?.lastMessage || null,
      lastError: existing?.lastError || null,
    } satisfies AgentSessionAgentRuntime;
  });
  record.title = plan.title;
  record.goal = plan.goal;
  record.plan = {
    ...plan,
    runtimeAgents,
  };
  record.status = 'planned';
  record.updatedAt = nowIso();
  record.plannerSessionId = options.plannerSessionId || record.plannerSessionId;
  record.plannerProfileId = options.plannerProfileId || record.plannerProfileId;

  await fs.mkdir(path.dirname(record.planPath), { recursive: true });
  await fs.writeFile(record.planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');
  await fs.writeFile(record.sharedStatusPath, `${JSON.stringify(buildSharedStatusDocument(record, plan), null, 2)}\n`, 'utf-8');
  await persistState();
  await appendAgentSessionEvent(agentSessionId, {
    type: 'agent-plan-saved',
    plannerSessionId: record.plannerSessionId,
    plannerProfileId: record.plannerProfileId,
    agents: plan.agents.map((agent) => ({ id: agent.id, provider: agent.provider })),
  });
  return cloneRecord(record);
}

export async function approveAgentSession(agentSessionId: string): Promise<AgentSessionRecord> {
  await ensureLoaded();
  const record = state.sessionsById[agentSessionId];
  if (!record) {
    throw new Error('Agent session was not found');
  }
  if (!record.plan) {
    throw new Error('Agent plan is missing');
  }

  const approvedAt = nowIso();
  record.status = 'approved';
  record.approvedAt = approvedAt;
  record.updatedAt = approvedAt;

  await fs.writeFile(record.sharedStatusPath, `${JSON.stringify(buildSharedStatusDocument(record, record.plan), null, 2)}\n`, 'utf-8');
  for (const agent of record.plan.agents) {
    await fs.mkdir(path.dirname(agent.instructionPath), { recursive: true });
    await fs.writeFile(agent.instructionPath, buildAgentInstructionDocument(record, record.plan, agent), 'utf-8');
    await fs.writeFile(agent.statusPath, `${JSON.stringify({
      agentSessionId: record.id,
      agentId: agent.id,
      name: agent.name,
      provider: agent.provider,
      status: 'pending',
      updatedAt: approvedAt,
      objective: agent.objective,
    }, null, 2)}\n`, 'utf-8');
  }

  await persistState();
  await appendAgentSessionEvent(agentSessionId, { type: 'agent-plan-approved' });
  return cloneRecord(record);
}

export async function markAgentSessionLaunched(agentSessionId: string): Promise<void> {
  await ensureLoaded();
  const record = state.sessionsById[agentSessionId];
  if (!record) {
    return;
  }
  record.status = 'running';
  record.launchedAt = nowIso();
  record.updatedAt = record.launchedAt;
  await persistState();
  await appendAgentSessionEvent(agentSessionId, { type: 'agent-session-launched' });
}

export async function recordAgentSessionLinkedSession(link: AgentSessionLinkRecord): Promise<void> {
  await ensureLoaded();
  state.sessionLinksBySessionId[link.sessionId] = cloneLink(link);
  await persistState();
  await appendAgentSessionEvent(link.agentSessionId, {
    type: 'linked-session-recorded',
    sessionId: link.sessionId,
    kind: link.kind,
    agentId: link.agentId,
    profileId: link.profileId,
  });
}

export async function getAgentSessionLinkForSession(sessionId: string): Promise<AgentSessionLinkRecord | null> {
  await ensureLoaded();
  const record = state.sessionLinksBySessionId[sessionId];
  return record ? cloneLink(record) : null;
}

export async function listAgentSessionLinksForSourceProfile(sourceProfileId: string): Promise<AgentSessionLinkRecord[]> {
  await ensureLoaded();
  return Object.values(state.sessionLinksBySessionId)
    .filter((record) => record.sourceProfileId === sourceProfileId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(cloneLink);
}

export function buildAgentPlanPrompt(record: AgentSessionRecord): string {
  const schemaPreview = {
    title: record.title,
    goal: record.goal,
    sharedStatusPath: record.sharedStatusPath,
    eventsPath: record.eventsPath,
    coordinationRules: defaultCoordinationRules(record.sharedStatusPath),
    agents: [
      {
        id: 'research-agent',
        name: 'Research Agent',
        provider: record.sourceProvider,
        role: 'מיפוי וניתוח',
        objective: 'חקירה ומיפוי חלקי המשימה',
        scopePaths: [record.cwd],
        dependsOn: [],
        notes: 'אופציונלי',
      },
    ],
  };

  return [
    `אתה מייצר תכנית חלוקת עבודה לסשן סוכנים של Code-AI.`,
    `מטרת העל: ${record.goal}`,
    `תיקיית העבודה הראשית: ${record.cwd}`,
    '',
    'עליך לכתוב קובץ JSON תקין בלבד לנתיב הבא:',
    record.planPath,
    '',
    'הקובץ חייב לתאר חלוקת תפקידים בין סוכנים, כאשר לכל סוכן יש תפקיד ברור, מטרה, provider, ותלות אפשרית בסוכנים אחרים.',
    `כל הסוכנים חייבים להשתמש בקובץ השיתופי הבא לפני כל פעולה גדולה ואחרי כל פעולה גדולה: ${record.sharedStatusPath}`,
    'לסוכנים יש גישה מלאה לכל הפרויקט, כולל סודות וחשבונות שירות זמינים ב-workspace, ואסור לך להגביל אותם ל-sandbox.',
    'אל תחזיר JSON בצ׳אט. כתוב את הקובץ לדיסק, ואז בתשובה כתוב בקצרה שתכנית הסוכנים נכתבה והיכן.',
    '',
    'מבנה ה-JSON הנדרש:',
    JSON.stringify(schemaPreview, null, 2),
  ].join('\n');
}

export function buildAgentExecutionPrompt(record: AgentSessionRecord, agent: AgentSessionAgentPlan): string {
  return [
    `אתה סוכן בתוך סשן סוכנים של Code-AI.`,
    `קרא תחילה את קובץ ההוראות שלך: ${agent.instructionPath}`,
    `לאחר מכן קרא את קובץ המצב השיתופי: ${record.sharedStatusPath}`,
    `ואז התחל לבצע את המטרה שלך: ${agent.objective}`,
    'לפני כל שלב משמעותי בדוק שוב את קובץ המצב השיתופי.',
    'אחרי כל שלב משמעותי עדכן גם את קובץ המצב השיתופי וגם את קובץ הסטטוס האישי שלך.',
    'מותר לך להשתמש בכל מה שקיים בפרויקט, כולל סודות, APIs וחשבונות שירות, כאשר זה נחוץ לביצוע המשימה.',
    'אל תבקש אישור. פעל באופן עצמאי ומסודר, אך שמור על תיעוד רציף בקבצי התיאום.',
    'בצע עכשיו איטרציה רצינית אחת של עבודתך, תעד את מה שעשית בקובצי התיאום, ואז עצור עם הודעת סיכום קצרה.',
    'אם אינך יכול להמשיך בגלל תלות בסוכן אחר, עדכן את shared-status ואת status.json שלך למצב blocked/awaiting-dependency, כתוב מה חסר, ואז עצור.',
    'אל תישאר רץ ברקע ללא סוף. לאחר שעדכנת את הקבצים וסיכמת את מצבך, עליך לסיים את ההרצה.',
  ].join('\n');
}

function buildRuntimeAgentFallback(plan: AgentSessionPlan, agent: AgentSessionAgentPlan): AgentSessionAgentRuntime {
  const existing = plan.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id);
  return existing || {
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    runtimeStatus: 'pending',
    linkedSessionId: null,
    queueItemId: null,
    updatedAt: null,
    lastMessage: null,
    lastError: null,
  };
}

async function rewriteSharedStatus(agentSessionId: string) {
  const record = state.sessionsById[agentSessionId];
  if (!record?.plan) {
    return;
  }

  await fs.writeFile(
    record.sharedStatusPath,
    `${JSON.stringify(buildSharedStatusDocument(record, record.plan), null, 2)}\n`,
    'utf-8'
  );
}

async function refreshAgentSessionLifecycle(agentSessionId: string) {
  const record = state.sessionsById[agentSessionId];
  if (!record?.plan) {
    return;
  }

  const runtimeAgents = record.plan.runtimeAgents || [];
  if (runtimeAgents.length === 0) {
    return;
  }

  const statuses = new Set(runtimeAgents.map((agent) => agent.runtimeStatus));
  if ([...statuses].every((status) => status === 'completed')) {
    record.status = 'completed';
  } else if ([...statuses].every((status) => status === 'failed' || status === 'cancelled' || status === 'completed')) {
    record.status = statuses.has('failed') ? 'failed' : 'completed';
  } else if (statuses.has('running') || statuses.has('queued')) {
    record.status = 'running';
  } else if (statuses.has('pending')) {
    record.status = record.approvedAt ? 'approved' : record.status;
  }

  record.updatedAt = nowIso();
}

export async function updateAgentRuntimeStatus(
  agentSessionId: string,
  agentId: string,
  patch: Partial<Pick<AgentSessionAgentRuntime, 'runtimeStatus' | 'linkedSessionId' | 'queueItemId' | 'lastMessage' | 'lastError'>> = {}
): Promise<AgentSessionRecord | null> {
  await ensureLoaded();
  const record = state.sessionsById[agentSessionId];
  if (!record?.plan) {
    return null;
  }

  const agent = record.plan.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return null;
  }

  const runtimeAgents = record.plan.runtimeAgents || record.plan.agents.map((candidate) => buildRuntimeAgentFallback(record.plan!, candidate));
  const runtimeIndex = runtimeAgents.findIndex((candidate) => candidate.id === agentId);
  const runtimeAgent = runtimeIndex >= 0 ? runtimeAgents[runtimeIndex] : buildRuntimeAgentFallback(record.plan, agent);
  const nextRuntime: AgentSessionAgentRuntime = {
    ...runtimeAgent,
    runtimeStatus: patch.runtimeStatus || runtimeAgent.runtimeStatus,
    linkedSessionId: patch.linkedSessionId === undefined ? runtimeAgent.linkedSessionId : patch.linkedSessionId,
    queueItemId: patch.queueItemId === undefined ? runtimeAgent.queueItemId : patch.queueItemId,
    lastMessage: patch.lastMessage === undefined ? runtimeAgent.lastMessage : patch.lastMessage,
    lastError: patch.lastError === undefined ? runtimeAgent.lastError : patch.lastError,
    updatedAt: nowIso(),
  };

  if (runtimeIndex >= 0) {
    runtimeAgents[runtimeIndex] = nextRuntime;
  } else {
    runtimeAgents.push(nextRuntime);
  }

  record.plan.runtimeAgents = runtimeAgents;
  record.updatedAt = nextRuntime.updatedAt || nowIso();

  await fs.mkdir(path.dirname(agent.statusPath), { recursive: true });
  await fs.writeFile(agent.statusPath, `${JSON.stringify({
    agentSessionId: record.id,
    agentId: agent.id,
    name: agent.name,
    provider: agent.provider,
    status: nextRuntime.runtimeStatus,
    linkedSessionId: nextRuntime.linkedSessionId,
    queueItemId: nextRuntime.queueItemId,
    updatedAt: nextRuntime.updatedAt,
    objective: agent.objective,
    lastMessage: nextRuntime.lastMessage,
    lastError: nextRuntime.lastError,
  }, null, 2)}\n`, 'utf-8');

  await refreshAgentSessionLifecycle(agentSessionId);
  await rewriteSharedStatus(agentSessionId);
  await persistState();
  await appendAgentSessionEvent(agentSessionId, {
    type: 'agent-runtime-updated',
    agentId,
    runtimeStatus: nextRuntime.runtimeStatus,
    linkedSessionId: nextRuntime.linkedSessionId,
    queueItemId: nextRuntime.queueItemId,
  });
  return cloneRecord(record);
}

export async function updateAgentSessionGoal(
  agentSessionId: string,
  goal: string
): Promise<AgentSessionRecord> {
  await ensureLoaded();
  const record = state.sessionsById[agentSessionId];
  if (!record) {
    throw new Error('Agent session was not found');
  }

  record.goal = normalizeMultilineText(goal, record.goal, 4000);
  record.updatedAt = nowIso();
  await persistState();
  await appendAgentSessionEvent(agentSessionId, { type: 'agent-session-goal-updated' });
  return cloneRecord(record);
}

export function resolveAgentProviderProfileId(
  sourceProfile: CodexProfile,
  provider: AppProvider
): string {
  const standardProviderProfile = CODEX_APP_CONFIG.profiles.find((candidate) => (
    candidate.mode === 'standard'
    && candidate.provider === provider
    && candidate.label === sourceProfile.label
  ));

  if (!standardProviderProfile) {
    throw new Error(`No standard ${provider} profile was found for ${sourceProfile.label}`);
  }

  const agentProfile = CODEX_APP_CONFIG.profiles.find((candidate) => (
    candidate.mode === 'agent'
    && candidate.sourceProfileId === standardProviderProfile.id
    && candidate.provider === provider
  ));

  if (!agentProfile) {
    throw new Error(`No internal agent ${provider} profile was found for ${standardProviderProfile.id}`);
  }

  return agentProfile.id;
}
