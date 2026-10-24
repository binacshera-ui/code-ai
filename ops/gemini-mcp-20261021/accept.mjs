import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fleetClient } from '../focus-notifications-20261020/fleet-live.mjs';

const afterFix = process.argv.includes('--after-fix');
const file = fileURLToPath(new URL(afterFix ? './acceptance-after.json' : './acceptance.json', import.meta.url));
const scope = { profileId: 'developer', sessionKey: '01a158ef-b0b5-7f92-b4f7-6e522f79fa8e' };
const api = await fleetClient();
const state = JSON.parse(await fs.readFile(file, 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return '{}';
}));
const save = () => fs.writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
if (process.argv.includes('--restore')) {
  if (state.originalUx) await api('local', '/session-ux-mode', { ...scope, uxMode: state.originalUx });
  if (state.originalDesign) await api('local', '/session-design-mode', { ...scope, designMode: state.originalDesign });
  if (state.originalFocus) await api('local', '/session-focus-mode', { ...scope, focusMode: state.originalFocus });
  state.restoredAt = new Date().toISOString(); await save();
} else if (!state.itemId) {
  const { items } = await api('local', '/queue/items');
  if (items.some(item => item.sessionId === scope.sessionKey && ['running', 'queued'].includes(item.status))) {
    throw Error('Maintenance session has active work; not submitting another turn.');
  }
  const before = afterFix ? JSON.parse(await fs.readFile(fileURLToPath(new URL('./acceptance.json', import.meta.url)), 'utf8')) : null;
  state.originalUx = before?.originalUx || (await api('local', '/session-ux-mode?' + new URLSearchParams(scope))).uxMode;
  state.originalDesign = before?.originalDesign || (await api('local', '/session-design-mode?' + new URLSearchParams(scope))).designMode;
  if (afterFix) {
    const mode = (await api('local', '/session-focus-mode?' + new URLSearchParams(scope))).focusMode;
    state.originalFocus = Object.fromEntries(['enabled','goal','rationalEnabled','planningMinutes','taskMinutes','decisionEnabled'].map(key => [key, mode[key]]));
  }
  await save();
  if (afterFix) {
    await api('local', '/session-focus-mode', { ...scope, focusMode: { ...state.originalFocus, enabled: false, rationalEnabled: false, decisionEnabled: false } });
    const { releaseWorkModeHoldsForUser } = await import('../work-mode-stop-20261020/owner-actions.mjs');
    const request = (url, init) => api('local', url.replace(/^\/api\/codex/, ''), init?.method === 'POST' ? JSON.parse(init.body || '{}') : undefined);
    await releaseWorkModeHoldsForUser(request, scope);
  }
  await api('local', '/session-ux-mode', { ...scope, uxMode: { ...state.originalUx, enabled: true } });
  await api('local', '/session-design-mode', { ...scope, designMode: { ...state.originalDesign, enabled: true } });
  const { item } = await api('local', '/queue/items', {
    profileId: scope.profileId, queueKey: scope.sessionKey, sessionId: scope.sessionKey,
    clientRequestId: afterFix ? 'gemini-mcp-acceptance-20261021-v2' : 'gemini-mcp-acceptance-20261021-v1',
    cwd: '/root/projects/code-ai/ops/gemini-mcp-20261021',
    promptPreview: 'בדיקת תחזוקה מבודדת: חיבור כלי Gemini',
    prompt: `Isolated maintenance acceptance test for the owner's Code AI tool repair. This is NOT a product design decision or customer project. Do not read or modify files, change settings, delegate, create goals, run shell commands, contact anyone, or implement advice. Use only the normal available MCP path. Make exactly ONE ux_mode.ux_friction_audit call with a short neutral request for a single sentence about clear waiting/error states in a generic application, and a separate genuine private codex_position. Then make exactly ONE design_mode.design_component call asking for one sentence about a generic read-only status badge, canvas_input mode omit with the reason that this is a non-visual transport acceptance test. These calls test transport and the configured Gemini 4 Argon, not business consultation. Do not retry a rejected call or use HTTP/direct provider workarounds. At the end report each actual result or error and actual returned model, in at most six lines.`,
  });
  state.itemId = item.id; state.submittedAt = new Date().toISOString(); await save();
}
if (state.itemId) {
  const { item } = await api('local', '/queue/items/' + state.itemId + '?includeSession=false');
  state.status = item.status; state.error = item.error || null;
  state.lastMessage = item.result?.lastMessage || null;
  state.nativeSubmission = item.nativeSubmission ? {
    deliveryPhase: item.nativeSubmission.deliveryPhase, turnId: item.nativeSubmission.turnId,
  } : null;
  await save();
  console.log(JSON.stringify({ itemId: state.itemId, status: state.status, error: state.error,
    lastMessage: state.lastMessage, nativeSubmission: state.nativeSubmission }));
}
