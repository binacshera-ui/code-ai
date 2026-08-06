import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { CODEX_APP_CONFIG } from './config.js';
import type { CodexProfile } from './codexService.js';
import {
  buildSessionUxModePromptAdditions,
  deleteSessionUxMode,
  dispatchUxConsultationForTests,
  extractUxSpecForTests,
  getSessionUxModeRecord,
  prepareCodexUxModeForRun,
  setGeminiUxInvokerForTests,
  setGeminiUxModelCatalogProviderForTests,
  setSessionUxMode,
  shutdownCodexUxModeBridge,
} from './codexUxMode.js';

const PROFILE_ID = 'ux-test-codex';
const SESSION_KEY = 'draft-ux-mode-test';
let testRoot = '';
let workspaceRoot = '';
let codexHome = '';
let profile: CodexProfile;
const prompts: string[] = [];
const requestedModels: Array<string | null | undefined> = [];

function fakeCatalog() {
  return {
    models: [{ slug: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', description: 'UX test', defaultReasoningLevel: 'medium', supportedReasoningLevels: [], isConfiguredDefault: true }],
    selectedModel: 'gemini-3.1-pro-preview',
  } as any;
}

function uxResponse(kind: string, final = false) {
  return JSON.stringify({
    version: '1.0',
    consultation_type: kind,
    executive_position: final ? 'Use a transparent progressive onboarding journey.' : 'Reduce ambiguity before asking for commitment.',
    evidence_and_assumptions: [{ claim: 'Users need an explicit first-value path.', basis: 'inference', confidence: 'medium' }],
    agreements: ['Keep all existing capabilities available.'],
    disagreements: [{ question: 'How much to ask upfront?', competing_view: 'Ask only what is needed for first value.', reason: 'Cognitive-load tradeoff.', resolution: 'Validate with completion and regret metrics.' }],
    friction_priorities: [{ friction: 'Unclear next action', severity: 'high', customer_harm: 'Anxiety and abandonment', recommended_move: 'Provide one explained primary action.' }],
    customer_stage_plan: [{ stage: 'onboard', customer_goal: 'Reach first value safely', action_and_emotion: 'Explores with uncertainty', friction_and_trust_risk: 'Opaque requirements', behavioral_and_psychological_rationale: 'Reduce cognitive load and preserve control', visual_and_content_guidance: 'Clear hierarchy and reversible copy', product_decision: 'Progressive disclosure', implementation_sequence: 'Instrument, prototype, test', success_signal: 'First-value completion', harm_guardrail: 'No coercive default', validation: 'Usability test and A/B experiment' }],
    ethical_guardrails: ['No dark patterns.'],
    validation_plan: [{ hypothesis: 'Clearer onboarding reduces abandonment.', method: 'Moderated usability test', success_metric: 'First-value completion', stop_condition: 'Trust complaints increase' }],
    open_questions: [],
    ...(final ? { final_recommendation: 'Proceed with transparent, reversible progressive disclosure.' } : {}),
  });
}

test('recovers the latest valid UX contract from noisy Gemini output', () => {
  const raw = `Prose first.\n\`\`\`json\n${uxResponse('ux_customer_journey')}\n\`\`\`\nMore prose.`;
  const parsed = extractUxSpecForTests(raw, 'ux_customer_journey');
  assert.equal(parsed.consultation_type, 'ux_customer_journey');
  assert.ok(Array.isArray(parsed.customer_stage_plan));
  assert.throws(() => extractUxSpecForTests('{"status":"ok"}', 'ux_customer_journey'), /contract-compatible JSON object/);
});

test('the standalone MCP advertises the bounded UX debate contract', async () => {
  const bridgeInfoFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-ux-mcp-')), 'bridge.json');
  await fs.writeFile(bridgeInfoFile, JSON.stringify({
    version: 1,
    url: 'http://127.0.0.1:9',
    token: 'x'.repeat(48),
  }), { encoding: 'utf8', mode: 0o600 });

  const mcpServer = path.join(CODEX_APP_CONFIG.appRoot, 'server', 'ux-mode', 'ux_mode_mcp_server.mjs');
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n');
  const child = spawnSync(process.execPath, [mcpServer, '--bridge-info-file', bridgeInfoFile], {
    input,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || 'UX MCP contract process failed');
  const messages = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const tools = messages.find((message) => message.id === 2)?.result?.tools || [];
  assert.deepEqual(tools.map((tool: any) => tool.name), [
    'ux_customer_journey',
    'ux_behavioral_economics',
    'ux_psychology_and_trust',
    'ux_visual_hierarchy',
    'ux_friction_audit',
    'ux_debate_turn',
    'ux_product_synthesis',
  ]);
  for (const tool of tools.slice(0, 5)) {
    assert.deepEqual(tool.inputSchema.required, ['request', 'codex_position']);
    assert.match(tool.description, /private|independent/i);
  }
  const debateTool = tools.find((tool: any) => tool.name === 'ux_debate_turn');
  assert.deepEqual(debateTool?.inputSchema.required, ['debate_id', 'codex_counterargument', 'decision_question']);
  assert.match(debateTool?.description || '', /ten explicit/i);
});

before(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-ux-mode-'));
  workspaceRoot = path.join(testRoot, 'workspace');
  codexHome = path.join(testRoot, 'codex-home');
  await Promise.all([
    fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true }),
    fs.mkdir(path.join(codexHome, 'skills'), { recursive: true }),
    fs.mkdir(CODEX_APP_CONFIG.uploadRoot, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(codexHome, 'config.toml'), '[features]\nmulti_agent = true\n', 'utf8'),
    fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'ux-fixture' }), 'utf8'),
    fs.writeFile(path.join(workspaceRoot, 'src', 'Onboarding.tsx'), 'export function Onboarding() { return <button>Continue</button>; }\n', 'utf8'),
    fs.writeFile(path.join(workspaceRoot, '.env'), 'SECRET_TOKEN=must-never-reach-gemini\n', 'utf8'),
  ]);
  profile = { id: PROFILE_ID, label: 'UX test', provider: 'codex', codexHome, workspaceCwd: workspaceRoot, defaultProfile: true };
  setGeminiUxModelCatalogProviderForTests(async () => fakeCatalog());
  setGeminiUxInvokerForTests(async (input) => {
    prompts.push(input.prompt);
    requestedModels.push(input.model);
    if (input.prompt.includes('Synthesis request:')) return { model: input.model || null, finalMessage: uxResponse('ux_product_synthesis', true) };
    if (input.prompt.includes('Codex counterargument for this turn:')) return { model: input.model || null, finalMessage: uxResponse('ux_debate_turn') };
    return { model: input.model || null, finalMessage: uxResponse('ux_customer_journey') };
  });
});

after(async () => {
  setGeminiUxInvokerForTests(null);
  setGeminiUxModelCatalogProviderForTests(null);
  await shutdownCodexUxModeBridge();
  await deleteSessionUxMode(PROFILE_ID, SESSION_KEY).catch(() => undefined);
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('keeps Codex private thesis out of Gemini’s first prompt, then supports an adversarial debate and synthesis', async () => {
  prompts.length = 0;
  requestedModels.length = 0;
  await setSessionUxMode(PROFILE_ID, SESSION_KEY, {
    enabled: true,
    geminiProfileId: 'gemini-developer',
    depth: 'deep',
    productBrief: 'A customer onboarding flow that must preserve existing navigation.',
    targetAudience: 'Busy first-time customers on mobile.',
    primaryOutcome: 'Reach an honest first value without coercion.',
  });
  const stored = await getSessionUxModeRecord(PROFILE_ID, SESSION_KEY);
  assert.ok(stored?.enabled);
  const prepared = await prepareCodexUxModeForRun(profile, PROFILE_ID, SESSION_KEY, workspaceRoot, stored);
  assert.ok(prepared);
  const config = await fs.readFile(path.join(prepared.envCodeXHome, 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.ux_mode\]/);
  assert.match(config, /ux_mode_mcp_server\.mjs/);
  assert.equal((await fs.lstat(path.join(prepared.envCodeXHome, 'skills', 'gemini-ux-partner'))).isSymbolicLink(), true);
  assert.match(buildSessionUxModePromptAdditions(stored), /שאלה ניטרלית/);
  assert.match(buildSessionUxModePromptAdditions(stored), /10 חילופי טיעון/);

  const secretThesis = 'PRIVATE_CODEX_THESIS: Force an early signup before showing value.';
  const initial = await dispatchUxConsultationForTests({
    profileId: PROFILE_ID,
    sessionKey: SESSION_KEY,
    workspaceCwd: workspaceRoot,
    record: stored,
    toolName: 'ux_customer_journey',
    arguments: {
      request: 'How should a mobile onboarding flow help a first-time customer reach first value?',
      codex_position: secretThesis,
      file_paths: ['src/Onboarding.tsx'],
      current_behavior: ['Existing navigation must remain available.'],
      success_metrics: ['First-value completion'],
    },
  });
  assert.equal(initial.independent_blind_review, true);
  assert.equal(initial.round, 1);
  assert.ok(typeof initial.debate_id === 'string');
  assert.doesNotMatch(prompts[0] || '', /PRIVATE_CODEX_THESIS/);
  assert.doesNotMatch(prompts[0] || '', /must-never-reach-gemini/);
  assert.match(prompts[0] || '', /Neutral product question/);
  const initialArtifact = await fs.readFile(String(initial.artifact_path), 'utf8');
  assert.doesNotMatch(initialArtifact, /PRIVATE_CODEX_THESIS/);

  const debateId = String(initial.debate_id);
  const roundTwo = await dispatchUxConsultationForTests({
    profileId: PROFILE_ID,
    sessionKey: SESSION_KEY,
    workspaceCwd: workspaceRoot,
    record: stored,
    toolName: 'ux_debate_turn',
    arguments: {
      debate_id: debateId,
      codex_counterargument: 'A guided account step may unlock continuity, but it must remain skippable and explain value first.',
      decision_question: 'When should optional account creation appear?',
      convergence_test: 'Users can reach first value without an account and understand the optional benefit.',
    },
  });
  assert.equal(roundTwo.round, 2);
  assert.match(prompts[1] || '', /guided account step/);
  assert.doesNotMatch(prompts[1] || '', /PRIVATE_CODEX_THESIS/);

  const synthesis = await dispatchUxConsultationForTests({
    profileId: PROFILE_ID,
    sessionKey: SESSION_KEY,
    workspaceCwd: workspaceRoot,
    record: stored,
    toolName: 'ux_product_synthesis',
    arguments: { request: 'Produce the final customer-stage UX plan.', debate_ids: [debateId] },
  });
  assert.ok(Array.isArray((synthesis.ux_product_plan as Record<string, unknown>).customer_stage_plan));
  assert.doesNotMatch(prompts[2] || '', /PRIVATE_CODEX_THESIS/);

  for (let round = 3; round <= 11; round += 1) {
    await dispatchUxConsultationForTests({
      profileId: PROFILE_ID,
      sessionKey: SESSION_KEY,
      workspaceCwd: workspaceRoot,
      record: stored,
      toolName: 'ux_debate_turn',
      arguments: { debate_id: debateId, codex_counterargument: `Counterargument ${round}`, decision_question: 'What is the lowest-friction path?' },
    });
  }
  await assert.rejects(
    dispatchUxConsultationForTests({
      profileId: PROFILE_ID,
      sessionKey: SESSION_KEY,
      workspaceCwd: workspaceRoot,
      record: stored,
      toolName: 'ux_debate_turn',
      arguments: { debate_id: debateId, codex_counterargument: 'One more attempt', decision_question: 'Should this run?' },
    }),
    (error: any) => error.uxToolError?.error_code === 'UX_DEBATE_CLOSED' || error.uxToolError?.error_code === 'UX_DEBATE_LIMIT_REACHED',
  );

  await assert.rejects(
    dispatchUxConsultationForTests({
      profileId: PROFILE_ID,
      sessionKey: SESSION_KEY,
      workspaceCwd: workspaceRoot,
      record: stored,
      toolName: 'ux_friction_audit',
      arguments: { request: 'Audit a secret.', codex_position: 'private', file_paths: ['.env'] },
    }),
    (error: any) => error.uxToolError?.error_code === 'UX_CONTEXT_SENSITIVE_FILE',
  );
  assert.ok(requestedModels.length > 0);
  assert.deepEqual([...new Set(requestedModels)], ['gemini-3.1-pro-preview']);
});
