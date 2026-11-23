import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import {
  CONVERSATION_SEARCH_MODE_SCRIPT_PATH,
  buildSessionConversationSearchModePromptAdditions,
  deleteSessionConversationSearchMode,
  getSessionConversationSearchMode,
  rebindSessionConversationSearchMode,
  setSessionConversationSearchMode,
  validateSessionConversationSearchMode,
} from './codexConversationSearchMode.js';

const execFileAsync = promisify(execFile);
const PROFILE_ID = 'conversation-search-test';
const SESSION_KEY = 'draft-conversation-search-test';
const REBOUND_KEY = 'conversation-search-real-session';
let testRoot = '';
let projectRoot = '';
let otherRoot = '';
let codexHome = '';
let titlesFile = '';

async function writeSession(options: {
  id: string;
  cwd: string;
  createdAt: string;
  userMessage: string;
  assistantMessage: string;
  forkedFromId?: string;
}) {
  const directory = path.join(codexHome, 'sessions', '2026', '08', '30');
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-${options.createdAt.replace(/[:.]/g, '-')}-${options.id}.jsonl`);
  const rows = [
    {
      timestamp: options.createdAt,
      type: 'session_meta',
      payload: {
        id: options.id,
        cwd: options.cwd,
        timestamp: options.createdAt,
        ...(options.forkedFromId ? { forked_from_id: options.forkedFromId } : {}),
      },
    },
    { timestamp: '2026-08-30T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: options.userMessage } },
    { timestamp: '2026-08-30T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: options.assistantMessage } },
    { timestamp: '2026-08-30T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'סוד כלי ייחודי שאסור להציג כתוצאת שיחה' } },
  ];
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

async function runSearch(scope: 'current' | 'project' | 'all', query: string) {
  const { stdout } = await execFileAsync(process.execPath, [
    CONVERSATION_SEARCH_MODE_SCRIPT_PATH,
    '--scope', scope,
    '--query', query,
    '--session-id', 'session-current',
    '--project-root', projectRoot,
    '--profile', `fixture=${codexHome}`,
    '--titles-file', titlesFile,
    '--base-url', 'https://app-codex.example.test',
    '--limit', '50',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout) as {
    scope: string;
    matches: Array<{ sessionId: string; title: string | null; link: string | null; excerpt: string }>;
    index: { profiles: Array<{ freshFiles: number; appendedFiles: number; unchangedFiles: number }> };
  };
}

before(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-conversation-search-'));
  projectRoot = path.join(testRoot, 'project');
  otherRoot = path.join(testRoot, 'other-project');
  codexHome = path.join(testRoot, 'codex-home');
  titlesFile = path.join(testRoot, 'session-titles.json');
  await Promise.all([
    fs.mkdir(path.join(projectRoot, 'frontend'), { recursive: true }),
    fs.mkdir(otherRoot, { recursive: true }),
  ]);
  await writeSession({
    id: 'session-current',
    cwd: path.join(projectRoot, 'frontend'),
    createdAt: '2026-08-30T09:00:00.000Z',
    userMessage: 'אני צריך מערכת לוגים חדשה לבינה כשרה 3.0',
    assistantMessage: 'תכננתי מערכת לוגים חדשה עם correlation id ושכבות אחסון.',
  });
  await writeSession({
    id: 'session-fork',
    cwd: path.join(projectRoot, 'frontend'),
    createdAt: '2026-08-30T11:00:00.000Z',
    userMessage: 'אני צריך מערכת לוגים חדשה לבינה כשרה 3.0',
    assistantMessage: 'המשך חדש שאינו מכיל את ביטוי החיפוש.',
    forkedFromId: 'session-current',
  });
  await writeSession({
    id: 'session-other',
    cwd: otherRoot,
    createdAt: '2026-08-30T12:00:00.000Z',
    userMessage: 'מערכת לוגים חדשה עבור מוצר אחר',
    assistantMessage: 'זה דיון נפרד בפרויקט אחר.',
  });
  await fs.writeFile(titlesFile, JSON.stringify({
    titles: {
      'fixture:session-current': 'מערכת הלוגים של 3.0',
      'fixture:session-other': 'לוגים במוצר אחר',
    },
  }), 'utf8');
});

after(async () => {
  await deleteSessionConversationSearchMode(PROFILE_ID, SESSION_KEY).catch(() => undefined);
  await deleteSessionConversationSearchMode(PROFILE_ID, REBOUND_KEY).catch(() => undefined);
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('validates, persists and rebinds a project-scoped mode', async () => {
  const validated = await validateSessionConversationSearchMode({ provider: 'codex' }, {
    enabled: true,
    scope: 'project',
    projectRoot,
  });
  const saved = await setSessionConversationSearchMode(PROFILE_ID, SESSION_KEY, validated);
  assert.equal(saved.scope, 'project');
  assert.equal((await getSessionConversationSearchMode(PROFILE_ID, SESSION_KEY)).enabled, true);
  const prompt = buildSessionConversationSearchModePromptAdditions({
    mode: saved,
    profileId: PROFILE_ID,
    sessionKey: 'session-current',
    cwd: path.join(projectRoot, 'frontend'),
  });
  assert.match(prompt, /code-ai-conversation-search/);
  assert.match(prompt, /--scope project/);
  assert.match(prompt, /--index-root/);
  assert.match(prompt, /session_meta/);

  await rebindSessionConversationSearchMode(PROFILE_ID, SESSION_KEY, REBOUND_KEY);
  assert.equal((await getSessionConversationSearchMode(PROFILE_ID, SESSION_KEY)).enabled, false);
  assert.equal((await getSessionConversationSearchMode(PROFILE_ID, REBOUND_KEY)).enabled, true);

  await assert.rejects(
    () => validateSessionConversationSearchMode({ provider: 'gemini' }, validated),
    /Codex/,
  );
  await assert.rejects(
    () => validateSessionConversationSearchMode({ provider: 'codex' }, { ...validated, projectRoot: path.join(testRoot, 'missing') }),
    /אינה קיימת|אינה נגישה/,
  );
});

test('search script enforces current, project and all scopes and excludes tool noise', async () => {
  const current = await runSearch('current', 'מערכת לוגים חדשה');
  assert.ok(current.index.profiles[0]?.freshFiles >= 3);
  assert.ok(current.matches.length >= 2);
  assert.deepEqual([...new Set(current.matches.map((match) => match.sessionId))], ['session-current']);
  assert.equal(current.matches[0]?.title, 'מערכת הלוגים של 3.0');
  assert.equal(current.matches[0]?.link, 'https://app-codex.example.test/session/fixture/session-current');

  const project = await runSearch('project', 'מערכת לוגים חדשה');
  assert.equal(project.matches.some((match) => match.sessionId === 'session-other'), false);
  assert.equal(project.matches.some((match) => match.sessionId === 'session-fork'), false);
  assert.equal(project.matches.some((match) => match.sessionId === 'session-current'), true);

  const all = await runSearch('all', 'מערכת לוגים חדשה');
  assert.equal(all.matches.some((match) => match.sessionId === 'session-current'), true);
  assert.equal(all.matches.some((match) => match.sessionId === 'session-other'), true);

  const toolNoise = await runSearch('all', 'סוד כלי ייחודי');
  assert.equal(toolNoise.matches.length, 0);

  const currentSourceFile = path.join(
    codexHome,
    'sessions',
    '2026',
    '08',
    '30',
    'rollout-2026-08-30T09-00-00-000Z-session-current.jsonl',
  );
  await fs.appendFile(currentSourceFile, `${JSON.stringify({
    timestamp: '2026-08-30T13:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'מילתאינדקסחדשה נמצאה לאחר עדכון מצטבר.' },
  })}\n`, 'utf8');
  const appended = await runSearch('current', 'מילתאינדקסחדשה');
  assert.equal(appended.matches.some((match) => match.sessionId === 'session-current'), true);
  assert.ok(appended.index.profiles[0]?.appendedFiles >= 1);
});
