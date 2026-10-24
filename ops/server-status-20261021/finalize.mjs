import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fleetClient } from '../focus-notifications-20261020/fleet-live.mjs';
const root = '/root/projects/code-ai', ops = root + '/ops/server-status-20261021';
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const stage = await json(ops + '/staged.json'), apiActivation = await json(ops + '/api-activation.json');
const uiActivation = await json(ops + '/ui-activation.json'), browser = await json(ops + '/browser-check.json');
const metrics = await json(ops + '/live-metrics.json');
assert.ok(stage.passed && apiActivation.complete && uiActivation.installed && browser.passed && metrics.passed);
assert.equal(browser.origin, 'https://app-codex.bina-cshera.co.il');
assert.equal(await fs.realpath(root + '/dist'), stage.candidate + '/dist');
const ui = '/var/www/code-ai-ui/releases/' + stage.sourceSha256.slice(0, 12);
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'), ui + '/locations.conf');
const manifest = await json(stage.candidate + '/release-files.json');
assert.equal(hash(await fs.readFile(stage.candidate + '/dist/app.mjs')), manifest.files['dist/app.mjs']);
for (const owner of apiActivation.nativeOwners) {
  const actual = await json('/home/' + owner.id + '/code-ai-native-owner/ownership.json');
  assert.equal(actual.nativePid, owner.nativePid); assert.equal(actual.nativeIdentity.startTime, owner.generation);
  assert.equal(actual.brokerModuleSha256, stage.nativeBrokerSha256);
}
const queue = (await json(root + '/.code-ai/queue/state.json')).items;
const activeIds = apiActivation.preservedActiveInputIds.map(id => {
  const item = queue.find(item => item.id === id); assert.ok(item);
  assert.equal(item.nativeSubmission.clientUserMessageId, 'code-ai:' + id);
  return { id, status: item.status, stableInputIdPreserved: true };
});
const api = await fleetClient(), health = await api('local', '/remote-agent/health');
assert.ok(health.ok && health.ready);
const latest = await api('local', '/server-status'); assert.equal(latest.version, 1); assert.equal(latest.hostname, 'web');
const receipt = { format: 'code-ai-server-status-release', version: 1, complete: true, finishedAt: new Date().toISOString(),
  scope: 'main Germany server (web) only', button: 'פעולות > מצב שרת, alongside Games and Terminal',
  delivered: ['CPU usage/free, per-logical-core usage and load averages', 'RAM used/available/free/cache and swap',
    'NVMe/HDD/SSD/unknown filesystem capacity/used/available, RAID ancestry and deduplication',
    'per-interface RX/TX rates and cumulative counters, reported link speed', 'up to 60 live samples, 2-second visible-only polling',
    'RTL, mobile scrolling, keyboard focus/close, dark/light, partial/stale/error/retry states'],
  engine: { name: 'systeminformation', version: '5.33.16', license: 'MIT', boundary: 'CPU/memory/filesystem/counters; narrow async Linux sysfs metadata' },
  release: { api: stage.candidate, ui, sourceSha256: stage.sourceSha256, appSha256: manifest.files['dist/app.mjs'], builder: 'user-server', beamAttested: false, buildUid: 65534 },
  verification: { unitTestsPassed: 31, unitTestsFailed: 0, focusedStrictTypescriptPassed: true,
    fullRepositoryTypescriptPassed: false, fullRepositoryTypescriptNote: 'Existing unrelated errors remain; no diagnostics in new status modules. Full log retained in isolated dependency workspace.',
    productionBuildsPassed: true, independentMetrics: metrics.independentlyVerified,
    liveApiHealthReady: health.ready, unauthenticatedPublicApiStatus: 403,
    browser, browserPersonalChrome: 'Created and reloaded background test tab; page tools returned MODE_TOOL_FAILED, so personal DOM verification is not claimed.' },
  continuity: { nativeWritersRestarted: false, activeInputIdsPreserved: activeIds, sourceInputsResent: false,
    geminiMcpRepairPreserved: true, svgInputRepairPreserved: true, otherServersModified: false, historyOrLocksDeleted: false },
  rollout: { firstUiProbeTimedOutAndAutomaticallyRolledBack: true, cause: 'Host-to-Cloudflare IPv4 reachability; both aliases verified over public IPv6 TLS',
    finalValidationTransport: 'IPv6 preferred in deployment validator only; global and application network settings unchanged',
    rollbackApi: stage.baseline, rollbackUi: stage.uiPointer },
  limitations: ['Provider bandwidth quota/guaranteed throughput is not known; link speed is not an internet speed test.',
    'History is only the open dashboard window, not persistent monitoring.',
    'Remote hosts were not upgraded or probed; older agents show unsupported/unavailable instead of main-server metrics.'] };
await fs.writeFile(ops + '/final-receipt.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ complete: true, api: stage.candidate, ui, testsPassed: 31, liveBrowserPassed: true,
  preservedNativeInputs: activeIds.length, nativeWritersRestarted: false, otherServersModified: false }));
