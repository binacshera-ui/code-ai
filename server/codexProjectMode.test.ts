import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  buildProjectModeQueueSpecs,
  buildSessionProjectModePromptAdditions,
  deleteSessionProjectMode,
  getSessionProjectMode,
  rebindSessionProjectMode,
  setSessionProjectMode,
  validateSessionProjectMode,
} from './codexProjectMode.js';

const PROFILE_ID = 'project-mode-test';
const SESSION_KEY = 'draft-project-mode-test';
const REBOUND_KEY = 'project-mode-real-session';
let root = '';
let frontendRoot = '';
let backendRoot = '';
let server: Server;
let port = 0;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-project-mode-'));
  frontendRoot = path.join(root, 'frontend');
  backendRoot = path.join(root, 'backend');
  await Promise.all([fs.mkdir(frontendRoot), fs.mkdir(backendRoot)]);
  server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test port was not allocated');
  port = address.port;
});

after(async () => {
  await deleteSessionProjectMode(PROFILE_ID, SESSION_KEY).catch(() => undefined);
  await deleteSessionProjectMode(PROFILE_ID, REBOUND_KEY).catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

function validInput() {
  return {
    enabled: true,
    projectName: 'Enterprise UI Factory',
    geminiProfileId: 'gemini-test',
    uiProtocol: 'http' as const,
    uiPort: port,
    frontendRoot,
    backendRoot,
    productBrief: 'Build and continuously improve the live UI against the real backend.',
    businessContext: 'A multi-tenant B2B product for Israeli companies.',
    primaryOutcome: 'Users complete critical journeys clearly and safely.',
    targetAudience: 'Israeli B2B operators and managers.',
    userArchetypes: 'Operator, manager, approver and administrator.',
    contentVoice: 'Direct, human, precise and action-oriented.',
    designSchool: 'High-quality Israeli technology product: clear, human and operational.',
    desiredFeeling: 'Confident, fast and calm.',
    fontFamily: 'Rubik',
    palette: {
      primary: '#112233', secondary: '#334455', accent: '#556677',
      background: '#f8fafc', surface: '#ffffff', text: '#0f172a',
    },
    referenceUrls: ['https://example.com/reference'],
    constraints: ['Preserve the existing live UI intent.'],
    successCriteria: ['No serious accessibility findings.'],
    programScale: 'enterprise' as const,
    maxParallelAgents: 8,
  };
}

test('requires a reachable UI port and complete product/design intake', async () => {
  const validated = await validateSessionProjectMode({ provider: 'codex' }, validInput());
  assert.equal(validated.portReachable, true);
  assert.equal(validated.uiUrl, `http://127.0.0.1:${port}`);
  assert.equal(validated.palette.primary, '#112233');
  await assert.rejects(
    () => validateSessionProjectMode({ provider: 'codex' }, { ...validInput(), uiPort: 1 }),
    /פורט|שירות/,
  );
  await assert.rejects(
    () => validateSessionProjectMode({ provider: 'codex' }, { ...validInput(), targetAudience: '' }),
    /קהל יעד/,
  );
  await assert.rejects(
    () => validateSessionProjectMode({ provider: 'codex' }, {
      ...validInput(),
      palette: { ...validInput().palette, primary: 'orange' },
    }),
    /hex/,
  );
});

test('persists, rebinds and renders a project mode without treating the live UI as disposable', async () => {
  const validated = await validateSessionProjectMode({ provider: 'codex' }, validInput());
  const saved = await setSessionProjectMode(PROFILE_ID, SESSION_KEY, validated);
  assert.equal((await getSessionProjectMode(PROFILE_ID, SESSION_KEY)).projectName, saved.projectName);
  assert.match(buildSessionProjectModePromptAdditions(saved), /ה־UI שכבר רץ בפורט הוא היעד החי/);
  assert.match(buildSessionProjectModePromptAdditions(saved), /סוכני Codex/);
  await rebindSessionProjectMode(PROFILE_ID, SESSION_KEY, REBOUND_KEY);
  assert.equal((await getSessionProjectMode(PROFILE_ID, SESSION_KEY)).enabled, false);
  assert.equal((await getSessionProjectMode(PROFILE_ID, REBOUND_KEY)).enabled, true);
});

test('builds an enterprise queue with product, design, implementation and verification phases', async () => {
  let mode = await getSessionProjectMode(PROFILE_ID, REBOUND_KEY);
  if (!mode.enabled) {
    const validated = await validateSessionProjectMode({ provider: 'codex' }, validInput());
    mode = await setSessionProjectMode(PROFILE_ID, REBOUND_KEY, validated);
  }
  const specs = buildProjectModeQueueSpecs('Improve the entire product end to end.', mode);
  assert.equal(specs.length, 8);
  assert.deepEqual(specs.map((spec) => spec.phaseId), [
    'foundation', 'product', 'visual-system', 'experience-blueprints',
    'implementation-foundations', 'implementation-product', 'critique-polish', 'verification',
  ]);
  assert.match(specs[0].prompt, /Improve the entire product/);
  assert.match(specs[6].prompt, /Gemini Design/);
});
