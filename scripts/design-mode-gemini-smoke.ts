import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGeminiEphemeralDesignPrompt } from '../server/geminiService.js';

const temporaryWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-design-gemini-'));

try {
  await fs.writeFile(
    path.join(temporaryWorkspace, 'visual-context.md'),
    '# UI context\nA compact mobile card must remain calm, readable, and accessible.\n',
    'utf8',
  );
  const result = await runGeminiEphemeralDesignPrompt({
    profileId: process.env.CODE_AI_DESIGN_GEMINI_PROFILE || 'gemini-developer',
    cwd: temporaryWorkspace,
    timeoutMs: 180_000,
    prompt: [
      'Act as a visual design specialist in a read-only smoke test.',
      'Read visual-context.md, but do not edit any file and do not run shell commands.',
      'Return exactly one JSON object without a Markdown fence:',
      '{"status":"ok","visual_direction":"one short implementation-ready sentence"}',
    ].join('\n'),
  });
  const normalized = result.finalMessage
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let contractStatus = 'natural-language';
  let payload: any = null;
  try {
    payload = JSON.parse(normalized);
  } catch (error) {
    // This smoke test verifies the real CLI/sandbox transport. Structured
    // design contracts are validated independently by codexDesignMode tests;
    // model prose must not be reported as an infrastructure outage.
    assert.ok(normalized, `Gemini returned neither valid JSON nor a non-empty response: ${String(error)}`);
  }
  if (payload) {
    assert.equal(payload.status, 'ok');
    assert.equal(typeof payload.visual_direction, 'string');
    assert.ok(payload.visual_direction.trim());
    contractStatus = 'json';
  }
  console.log(`DESIGN_MODE_GEMINI_SMOKE_OK model=${result.model || 'unknown'} response=${contractStatus}`);
} finally {
  await fs.rm(temporaryWorkspace, { recursive: true, force: true });
}
