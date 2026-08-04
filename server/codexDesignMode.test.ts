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
  await assert.rejects(
    fs.access(path.join(codexHome, 'skills', 'gemini-design-partner')),
    /ENOENT/,
  );
  const activePrompt = buildSessionDesignModePromptAdditions(stored);
  assert.match(activePrompt, /omit, full או region/);
  assert.match(activePrompt, /לא נשלח אוטומטית/);

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
    return {
      model: input.model || 'gemini-3-pro-preview',
      finalMessage: JSON.stringify({
        version: '1.0',
        executive_direction: 'Calm, precise, and implementation-ready.',
        preserve_exactly: ['Keep action'],
        implementation_handoff: [{ file_hint: 'src/Card.tsx', instruction: 'Polish visual hierarchy only.' }],
      }),
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
  assert.doesNotMatch(invocations[0]?.prompt || '', /must-never-reach-gemini/);
  assert.equal((regionResult.canvas_decision as any).mode, 'region');
  assert.equal((regionResult.implementation_contract as any).code_and_behavior_owner, 'Codex');
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
});
