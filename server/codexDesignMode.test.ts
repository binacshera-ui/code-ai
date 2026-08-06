import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

import { CODEX_APP_CONFIG } from './config.js';
import type { CodexProfile } from './codexService.js';
import {
  buildSessionDesignModePromptAdditions,
  deleteSessionDesignMode,
  dispatchDesignConsultationForTests,
  extractDesignSpecForTests,
  getSessionDesignModeRecord,
  prepareCodexDesignModeForRun,
  setGeminiDesignInvokerForTests,
  setGeminiDesignModelCatalogProviderForTests,
  setSessionDesignMode,
  shutdownCodexDesignModeBridge,
} from './codexDesignMode.js';

const execFileAsync = promisify(execFile);
const PROFILE_ID = 'design-test-codex';
const SESSION_KEY = 'draft-design-mode-test';

let testRoot = '';
let workspaceRoot = '';
let codexHome = '';
let profile: CodexProfile;

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function fakeCatalog() {
  return {
    models: [{
      slug: 'gemini-3-pro-preview',
      displayName: 'Gemini 3 Pro Preview',
      description: 'Design test model',
      defaultReasoningLevel: 'medium',
      supportedReasoningLevels: [],
      isConfiguredDefault: true,
    }],
    selectedModel: 'gemini-3-pro-preview',
    selectedReasoningEffort: 'medium',
    responseSpeed: null,
    permissions: null,
  } as any;
}

test('recovers the final contract-compatible design spec from noisy multi-object output', () => {
  const draft = {
    version: '1.0',
    consultation_type: 'design_review',
    executive_direction: 'Draft direction',
    preserve_exactly: ['Keep behavior'],
    implementation_handoff: [{ code_snippet: '.clock { color: red; }' }],
    validation_checklist: ['Draft check'],
    design_tokens: { colors: [{ role: 'draft', value: '#ff0000' }] },
    component_blueprint: [{ target: '.clock', change: 'Draft only' }],
    accessibility_rules: ['Draft rule'],
  };
  const final = {
    version: '1.0',
    consultation_type: 'design_review',
    executive_direction: 'Final accepted direction',
    preserve_exactly: ['Keep behavior'],
    implementation_handoff: [{
      language: 'css',
      code_snippet: '.clock { color: var("--clock-accent"); }',
    }],
    validation_checklist: ['Final check'],
  };
  const raw = [
    'Analysis containing prose braces {not valid JSON}.',
    '```json',
    JSON.stringify(draft),
    '```',
    'The response is refined below.',
    '```json',
    JSON.stringify(final),
    '```',
    'Trailing non-JSON commentary.',
  ].join('\n');

  const parsed = extractDesignSpecForTests(raw, 'design_review');
  assert.equal(parsed.executive_direction, 'Final accepted direction');
  assert.equal(parsed.consultation_type, 'design_review');
  assert.equal(
    (parsed.implementation_handoff as Array<Record<string, unknown>>)[0]?.code_snippet,
    '.clock { color: var("--clock-accent"); }',
  );
  assert.throws(
    () => extractDesignSpecForTests('Prose only, then {"status":"ok"}.', 'design_review'),
    /contract-compatible JSON object/,
  );
});

before(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-design-mode-'));
  workspaceRoot = path.join(testRoot, 'workspace');
  codexHome = path.join(testRoot, 'codex-home');
  await Promise.all([
    fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true }),
    fs.mkdir(path.join(codexHome, 'skills'), { recursive: true }),
    fs.mkdir(CODEX_APP_CONFIG.uploadRoot, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(codexHome, 'config.toml'), '[features]\nmulti_agent = true\n', 'utf8'),
    fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'design-fixture' }), 'utf8'),
    fs.writeFile(
      path.join(workspaceRoot, 'src', 'Card.tsx'),
      'export function Card() { return <button className="rounded">Keep action</button>; }\n',
      'utf8',
    ),
    fs.writeFile(path.join(workspaceRoot, '.env'), 'SECRET_TOKEN=must-never-reach-gemini\n', 'utf8'),
  ]);
  profile = {
    id: PROFILE_ID,
    label: 'Design Test',
    provider: 'codex',
    codexHome,
    workspaceCwd: workspaceRoot,
    defaultProfile: true,
  };
});

after(async () => {
  setGeminiDesignInvokerForTests(null);
  setGeminiDesignModelCatalogProviderForTests(null);
  await shutdownCodexDesignModeBridge();
  await deleteSessionDesignMode(PROFILE_ID, SESSION_KEY).catch(() => undefined);
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('activates the MCP and skill only for an enabled Design Mode session', async () => {
  const python = process.env.CODE_AI_BROWSER_PYTHON?.trim()
    || path.join(CODEX_APP_CONFIG.appRoot, '.venv', 'bin', 'python');
  const canvasUpload = path.join(CODEX_APP_CONFIG.uploadRoot, `design-test-${process.pid}.png`);
  await execFileAsync(python, [
    '-c',
    'from PIL import Image; import sys; Image.new("RGBA", (100, 80), (240, 230, 255, 255)).save(sys.argv[1], "PNG")',
    canvasUpload,
  ]);

  await setSessionDesignMode(PROFILE_ID, SESSION_KEY, {
    enabled: true,
    geminiProfileId: 'gemini-developer',
    quality: 'deep',
    brief: 'Soft editorial interface; preserve every existing action.',
    canvasAttachment: {
      id: 'canvas-upload',
      name: 'canvas.png',
      mimeType: 'image/png',
      size: (await fs.stat(canvasUpload)).size,
      path: canvasUpload,
      isImage: true,
    },
  });
  const stored = await getSessionDesignModeRecord(PROFILE_ID, SESSION_KEY);
  assert.ok(stored?.enabled);
  assert.ok(stored.canvasPath);

  const prepared = await prepareCodexDesignModeForRun(
    profile,
    PROFILE_ID,
    SESSION_KEY,
    workspaceRoot,
    stored,
  );
  assert.ok(prepared);
  assert.notEqual(prepared.envCodeXHome, codexHome);
  const overlayConfig = await fs.readFile(path.join(prepared.envCodeXHome, 'config.toml'), 'utf8');
  assert.match(overlayConfig, /\[mcp_servers\.design_mode\]/);
  assert.match(overlayConfig, /design_mode_mcp_server\.mjs/);
  assert.equal(
    (await fs.lstat(path.join(prepared.envCodeXHome, 'skills', 'gemini-design-partner'))).isSymbolicLink(),
    true,
  );
  const activeSkill = await fs.readFile(
    path.join(prepared.envCodeXHome, 'skills', 'gemini-design-partner', 'SKILL.md'),
    'utf8',
  );
  assert.match(activeSkill, /three total `design_review` calls/);
  assert.match(activeSkill, /implementation_handoff\.code_snippet/);
  await assert.rejects(
    fs.access(path.join(codexHome, 'skills', 'gemini-design-partner')),
    /ENOENT/,
  );
  const activePrompt = buildSessionDesignModePromptAdditions(stored);
  assert.match(activePrompt, /omit, full או region/);
  assert.match(activePrompt, /לא נשלח אוטומטית/);
  assert.match(activePrompt, /מקור המימוש המועדף/);
  assert.match(activePrompt, /לכל היותר 3 פעמים/);

  const bridgeInfo = JSON.parse(await fs.readFile(stored.bridgeInfoFile, 'utf8')) as {
    url: string;
    token: string;
  };
  const invocations: Array<{ prompt: string; dimensions: { width: number; height: number } | null }> = [];
  setGeminiDesignModelCatalogProviderForTests(async () => fakeCatalog());
  setGeminiDesignInvokerForTests(async (input) => {
    const regionPath = path.join(input.cwd, 'canvas-region.png');
    const region = await fs.readFile(regionPath).catch(() => null);
    invocations.push({
      prompt: input.prompt,
      dimensions: region ? readPngDimensions(region) : null,
    });
    const standardResponse = {
      model: input.model || 'gemini-3-pro-preview',
      finalMessage: JSON.stringify({
        version: '1.0',
        executive_direction: 'Calm, precise, and implementation-ready.',
        preserve_exactly: ['Keep action'],
        implementation_handoff: [{ file_hint: 'src/Card.tsx', instruction: 'Polish visual hierarchy only.' }],
      }),
    };
    if (input.prompt.includes('Return irrecoverable output')) {
      return { ...standardResponse, finalMessage: '午-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x' };
    }
    if (!input.prompt.includes('Recover the final review')) return standardResponse;
    const draft = {
      version: '1.0',
      consultation_type: 'design_review',
      executive_direction: 'Draft review',
      preserve_exactly: ['Keep action'],
      implementation_handoff: [{ code_snippet: '.rounded { border-radius: 8px; }' }],
    };
    const final = {
      ...draft,
      executive_direction: 'Recovered final review',
      implementation_handoff: [{
        language: 'css',
        code_snippet: '.rounded { border-radius: 12px; }',
      }],
    };
    return {
      ...standardResponse,
      finalMessage: `Reasoning before JSON.\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\nRefined result.\n\`\`\`json\n${JSON.stringify(final)}\n\`\`\`\nDone.`,
    };
  });

  const regionResult = await dispatchDesignConsultationForTests({
    profileId: PROFILE_ID,
    sessionKey: SESSION_KEY,
    workspaceCwd: workspaceRoot,
    record: stored,
    toolName: 'design_component',
    arguments: {
      request: 'Polish the card without changing its action.',
      file_paths: ['src/Card.tsx'],
      current_behavior: ['The button action must remain available.'],
      canvas_input: {
        mode: 'region',
        reason: 'Only the card area is relevant.',
        focus: 'Card spacing and hierarchy',
        region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      },
    },
  });
  assert.deepEqual(invocations[0]?.dimensions, { width: 50, height: 40 });
  assert.match(invocations[0]?.prompt || '', /canvas-region\.png/);
  assert.match(invocations[0]?.prompt || '', /Keep action/);
  assert.match(invocations[0]?.prompt || '', /Soft editorial interface/);
  assert.match(invocations[0]?.prompt || '', /primary implementation source/);
  assert.match(invocations[0]?.prompt || '', /code_snippet is required/);
  assert.doesNotMatch(invocations[0]?.prompt || '', /must-never-reach-gemini/);
  assert.equal((regionResult.canvas_decision as any).mode, 'region');
  assert.equal((regionResult.implementation_contract as any).code_and_behavior_owner, 'Codex');
  assert.equal((regionResult.implementation_contract as any).gemini_visual_code_is_primary, true);
  assert.equal((regionResult.implementation_contract as any).copy_compatible_visual_snippets_verbatim, true);
  await fs.access(String(regionResult.artifact_path));

  await dispatchDesignConsultationForTests({
    profileId: PROFILE_ID,
    sessionKey: SESSION_KEY,
    workspaceCwd: workspaceRoot,
    record: stored,
    toolName: 'design_polish',
    arguments: {
      request: 'Polish typography without using the canvas.',
      file_paths: ['src/Card.tsx'],
      canvas_input: { mode: 'omit', reason: 'Source and tokens are sufficient.' },
    },
  });
  assert.equal(invocations[1]?.dimensions, null);
  assert.match(invocations[1]?.prompt || '', /No reference image was intentionally supplied/);

  const recoveredReview = await dispatchDesignConsultationForTests({
    profileId: PROFILE_ID,
    sessionKey: SESSION_KEY,
    workspaceCwd: workspaceRoot,
    record: stored,
    toolName: 'design_review',
    arguments: {
      request: 'Recover the final review from noisy output.',
      file_paths: ['src/Card.tsx'],
      canvas_input: { mode: 'omit', reason: 'The parser behavior is under test.' },
    },
  });
  assert.equal(
    (recoveredReview.design_spec as Record<string, unknown>).executive_direction,
    'Recovered final review',
  );
  assert.equal(
    ((recoveredReview.design_spec as any).implementation_handoff as Array<Record<string, unknown>>)[0]?.code_snippet,
    '.rounded { border-radius: 12px; }',
  );

  await assert.rejects(
    dispatchDesignConsultationForTests({
      profileId: PROFILE_ID,
      sessionKey: SESSION_KEY,
      workspaceCwd: workspaceRoot,
      record: stored,
      toolName: 'design_review',
      arguments: {
        request: 'Return irrecoverable output.',
        canvas_input: { mode: 'omit', reason: 'The invalid-output path is under test.' },
      },
    }),
    (error: any) => {
      assert.equal(error.designToolError?.error_code, 'DESIGN_OUTPUT_INVALID');
      assert.equal(error.designToolError?.is_retryable, true);
      assert.match(error.designToolError?.suggested_remediation || '', /maximum of 3 total design_review calls/);
      return true;
    },
  );
  const invalidArtifacts = (await fs.readdir(stored.artifactsDir))
    .filter((name) => name.endsWith('-invalid.json'));
  assert.equal(invalidArtifacts.length, 1);
  const invalidMode = (await fs.stat(path.join(stored.artifactsDir, invalidArtifacts[0]))).mode & 0o777;
  assert.equal(invalidMode, 0o600);

  await assert.rejects(
    dispatchDesignConsultationForTests({
      profileId: PROFILE_ID,
      sessionKey: SESSION_KEY,
      workspaceCwd: workspaceRoot,
      record: stored,
      toolName: 'design_component',
      arguments: { request: 'Missing an explicit canvas decision.' },
    }),
    /explicitly choose canvas_input\.mode/,
  );
  await assert.rejects(
    dispatchDesignConsultationForTests({
      profileId: PROFILE_ID,
      sessionKey: SESSION_KEY,
      workspaceCwd: workspaceRoot,
      record: stored,
      toolName: 'design_component',
      arguments: {
        request: 'Try to read a secret.',
        file_paths: ['.env'],
        canvas_input: { mode: 'omit', reason: 'No visual reference needed.' },
      },
    }),
    /Sensitive files cannot be sent/,
  );

  await setSessionDesignMode(PROFILE_ID, SESSION_KEY, { enabled: false });
  const disabled = await getSessionDesignModeRecord(PROFILE_ID, SESSION_KEY);
  assert.ok(disabled && !disabled.enabled);
  assert.equal(
    await prepareCodexDesignModeForRun(profile, PROFILE_ID, SESSION_KEY, workspaceRoot, disabled),
    null,
  );
  assert.match(buildSessionDesignModePromptAdditions(disabled), /אינם זמינים/);
  await assert.rejects(fs.access(stored.bridgeInfoFile), /ENOENT/);

  const staleBridgeResponse = await fetch(`${bridgeInfo.url}/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bridgeInfo.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'design_component',
      arguments: {
        request: 'This stale call must be denied.',
        canvas_input: { mode: 'omit', reason: 'Test' },
      },
    }),
  });
  assert.equal(staleBridgeResponse.status, 401);
});

test('the standalone MCP advertises all bounded design tools and the canvas decision contract', async () => {
  const bridgeInfoFile = path.join(testRoot, 'mcp-contract-bridge.json');
  await fs.writeFile(bridgeInfoFile, JSON.stringify({
    version: 1,
    url: 'http://127.0.0.1:9',
    token: 'x'.repeat(48),
  }), { encoding: 'utf8', mode: 0o600 });
  const mcpServer = path.join(CODEX_APP_CONFIG.appRoot, 'server', 'design-mode', 'design_mode_mcp_server.mjs');
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
  assert.equal(child.status, 0, child.stderr || 'MCP contract process failed');
  const messages = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const tools = messages.find((message) => message.id === 2)?.result?.tools || [];
  assert.deepEqual(tools.map((tool: any) => tool.name), [
    'design_system',
    'design_screen',
    'design_component',
    'design_review',
    'design_responsive',
    'design_polish',
  ]);
  for (const tool of tools) {
    assert.deepEqual(tool.inputSchema.required, ['request', 'canvas_input']);
    assert.deepEqual(tool.inputSchema.$defs.canvasInput.properties.mode.enum, ['omit', 'full', 'region']);
  }
  const reviewTool = tools.find((tool: any) => tool.name === 'design_review');
  assert.match(reviewTool?.description || '', /at most three design_review calls/);
});
