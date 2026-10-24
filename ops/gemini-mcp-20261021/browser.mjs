import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fleetClient } from '../focus-notifications-20261020/fleet-live.mjs';
const api = await fleetClient(), scope = { profileId: 'developer', sessionKey: '01a158ef-b0b5-7f92-b4f7-6e522f79fa8e' };
const file = fileURLToPath(new URL('./browser.json', import.meta.url));
const state = JSON.parse(await fs.readFile(file, 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return '{}';
}));
const save = () => fs.writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
if (process.argv.includes('--restore')) {
  if (state.originalBrowser) await api('local', '/session-browser-mode', { ...scope, browserMode: state.originalBrowser });
  state.restoredAt = new Date().toISOString(); await save();
} else if (!state.itemId) {
  const { items } = await api('local', '/queue/items');
  if (items.some(item => item.sessionId === scope.sessionKey && ['running','queued'].includes(item.status))) throw Error('Maintenance turn still active');
  state.originalBrowser = (await api('local', '/session-browser-mode?' + new URLSearchParams(scope))).browserMode; await save();
  if (state.originalBrowser.enabled) throw Error('Maintenance browser already active; do not reuse it');
  await api('local', '/session-browser-mode', { ...scope, browserMode: { enabled: true, headless: true, profileSeed: 'empty' } });
  const { item } = await api('local', '/queue/items', {
    profileId: scope.profileId, queueKey: scope.sessionKey, sessionId: scope.sessionKey,
    cwd: '/root/projects/code-ai/ops/gemini-mcp-20261021', clientRequestId: 'gemini-mcp-browser-20261021-v1',
    promptPreview: 'בדיקת תחזוקה: ניווט בדפדפן מבודד',
    prompt: 'Isolated maintenance acceptance only. Use only browser_mode MCP, never personal Chrome. Call tabs_context to identify the isolated test tab (if none use tabs_create). Navigate that tab to https://example.com/ with timeout 30000, then read_page and confirm its Example Domain title/content. No other URLs, Gemini consultations, shell, file changes, screenshots, form submission, account access, goals or delegation. Do not retry rejection or use HTTP/direct-provider workarounds. Report actual final URL/title and whether navigation and read succeeded in at most three lines.',
  });
  state.itemId = item.id; state.startedAt = new Date().toISOString(); await save();
}
if (state.itemId) {
  const { item } = await api('local', '/queue/items/' + state.itemId + '?includeSession=false');
  state.status = item.status; state.error = item.error || null; state.nativeTurnId = item.nativeSubmission?.turnId || null; await save();
  console.log(JSON.stringify({ itemId: state.itemId, status: state.status, error: state.error, nativeTurnId: state.nativeTurnId }));
}
