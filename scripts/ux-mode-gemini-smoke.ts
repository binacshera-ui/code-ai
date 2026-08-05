import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGeminiEphemeralSpecialistPrompt } from '../server/geminiService.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-ux-gemini-'));

try {
  await fs.writeFile(
    path.join(workspace, 'product-context.md'),
    '# Product context\nA mobile customer onboarding flow must deliver first value before optional account creation.\n',
    'utf8',
  );
  const result = await runGeminiEphemeralSpecialistPrompt({
    profileId: process.env.CODE_AI_UX_GEMINI_PROFILE || 'gemini-developer',
    cwd: workspace,
    timeoutMs: 180_000,
    prompt: [
      'Act as a read-only UX/product specialist in a smoke test. Read product-context.md; do not edit files or run commands.',
      'Answer the neutral question: How should this onboarding flow reach first value transparently?',
      'Return exactly one JSON object without a Markdown fence:',
      '{"version":"1.0","consultation_type":"ux_customer_journey","executive_position":"one concise position","customer_stage_plan":[{"stage":"onboard","customer_goal":"goal"}],"ethical_guardrails":["transparent"]}',
    ].join('\n'),
  });
  const normalized = result.finalMessage.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const payload = JSON.parse(normalized);
  assert.equal(payload.consultation_type, 'ux_customer_journey');
  assert.equal(typeof payload.executive_position, 'string');
  assert.ok(Array.isArray(payload.customer_stage_plan));
  console.log(`UX_MODE_GEMINI_SMOKE_OK model=${result.model || 'unknown'}`);
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}
