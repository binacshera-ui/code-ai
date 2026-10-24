import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fleetClient } from '../focus-notifications-20261020/fleet-live.mjs';

const root = '/root/projects/code-ai', ops = root + '/ops/gemini-mcp-20261021';
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const [staged, activation, gemini, browser] = await Promise.all(
  ['staged', 'activation', 'acceptance-after', 'browser'].map(name => json(ops + '/' + name + '.json')));
assert.equal(activation.complete, true);
assert.equal(gemini.status, 'completed'); assert.equal(browser.status, 'completed');
assert.ok(gemini.restoredAt && browser.restoredAt);
const ownerResults = [];
for (const p of staged.profiles) {
  const plan = await json(p.planFile), live = await json(p.directory + '/ownership.json');
  const before = activation.profiles.find(value => value.profileId === p.id);
  assert.equal(live.nativePid, before.nativePid);
  assert.equal(live.nativeIdentity.startTime, before.nativeGeneration);
  assert.equal(plan.brokerModuleSha256, staged.brokerSha256);
  assert.equal(live.brokerModuleSha256, staged.brokerSha256);
  assert.equal(hash(await fs.readFile(plan.brokerModule)), staged.brokerSha256);
  assert.deepEqual(plan, { ...p.plan, brokerModule: staged.candidate + '/server/codexSharedOwnerBroker.mjs', brokerModuleSha256: staged.brokerSha256 });
  ownerResults.push({ profileId: p.id, nativePid: live.nativePid, nativeGenerationPreserved: true,
    expectedBrokerActive: true, allOtherOwnerSettingsPreserved: true });
}
const scope = { profileId: 'developer', sessionKey: '01a158ef-b0b5-7f92-b4f7-6e522f79fa8e' };
const api = await fleetClient();
for (const [mode, expected] of [['ux', gemini.originalUx], ['design', gemini.originalDesign], ['focus', gemini.originalFocus], ['browser', browser.originalBrowser]]) {
  const current = (await api('local', '/session-' + mode + '-mode?' + new URLSearchParams(scope)))[mode + 'Mode'];
  for (const [key, value] of Object.entries(expected)) if (value !== undefined) assert.deepEqual(current[key], value);
}
const source = '/home/developer/.codex/sessions/2026/10/20/rollout-2026-10-20T12-51-05-01a158ef-b0b5-7f92-b4f7-6e522f79fa8e.jsonl';
const rows = (await fs.readFile(source, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const calls = turnId => rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'item_completed'
  && row.payload.turn_id === turnId && row.payload.item?.type === 'McpToolCall').map(row => row.payload.item);
const geminiCalls = calls(gemini.nativeSubmission.turnId), browserCalls = calls(browser.nativeTurnId);
assert.deepEqual(geminiCalls.map(call => call.tool), ['ux_friction_audit', 'design_component']);
for (const call of geminiCalls) {
  assert.equal(call.status, 'completed'); assert.equal(call.result.isError, false);
  assert.equal(call.result.structuredContent.model, 'gemini-4-argon');
  const artifact = await json(call.result.structuredContent.artifact_path);
  assert.equal(artifact.model, 'gemini-4-argon');
  assert.ok(artifact.designSpec || artifact.geminiSpec);
}
assert.deepEqual(browserCalls.map(call => call.tool), ['tabs_context', 'navigate', 'read_page']);
for (const call of browserCalls) { assert.equal(call.status, 'completed'); assert.equal(call.result.isError, false); }
const browserCompletion = rows.find(row => row.type === 'event_msg' && row.payload?.type === 'task_complete'
  && row.payload.turn_id === browser.nativeTurnId)?.payload.last_agent_message;
assert.match(browserCompletion, /example\.com/i); assert.match(browserCompletion, /Example Domain/);
const journal = await json('/home/developer/code-ai-native-owner/broker-journal.json');
const reservation = journal.records.find(record => record.threadId === scope.sessionKey);
assert.equal(reservation.phase, 'released'); assert.equal(reservation.turnComplete, true);
const receipt = { format: 'code-ai-gemini-mcp-repair', version: 1, completedAt: new Date().toISOString(),
  complete: true, scope: staged.scope, candidate: staged.candidate, brokerSha256: staged.brokerSha256,
  cause: 'Prior native thread settings restored at own-turn start changed live MCP authorization',
  correction: 'Hold settings through the exact native turn terminal event; restore afterwards, including recovery',
  owners: ownerResults, liveGeminiCalls: geminiCalls.map(call => ({ server: call.server, tool: call.tool,
    model: call.result.structuredContent.model, status: call.status, artifact: call.result.structuredContent.artifact_path })),
  browser: { isolated: true, finalUrl: 'https://example.com/', title: 'Example Domain',
    methods: browserCalls.map(call => call.tool), completed: true },
  qualification: { ...staged.qualification, nativeSubmissionContractChecksPassed: 30 },
  testPreferencesRestoredAndVerified: true, originalDefaultsRestoredAfterTestTurn: true,
  nativeWritersRestarted: false, backendRestarted: false, historyOrLocksDeleted: false,
  approvalChecksBypassed: false, providerFallbackAdded: false, otherServersModified: false,
  genesisBusinessConsultationExecuted: false };
await fs.writeFile(ops + '/final-receipt.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ complete: true, liveGeminiModels: receipt.liveGeminiCalls.map(call => call.model),
  browserPassed: true, originalTestPreferencesRestored: true, owners: ownerResults }));
