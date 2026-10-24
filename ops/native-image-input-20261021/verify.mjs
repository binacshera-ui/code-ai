import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fleetClient } from '../focus-notifications-20261020/fleet-live.mjs';

const root = '/root/projects/code-ai', ops = root + '/ops/native-image-input-20261021';
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const [stage, activation, recovery] = await Promise.all(['staged','activation','recovery'].map(name => json(ops + '/' + name + '.json')));
assert.equal(activation.complete, true); assert.equal(recovery.originalInputWasNotAccepted, true);
assert.equal(recovery.acceptedExactlyOnce, true); assert.equal(recovery.svgPreservedAsAttachedFile, true);
assert.equal(await fs.realpath(root + '/dist'), stage.candidate + '/dist');
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'), stage.uiPointer);
assert.equal(hash(await fs.readFile(stage.candidate + '/dist/app.mjs')), stage.request.expectedAppSha256);
for (const n of activation.nativeOwners) {
  const owner = await json('/home/' + n.id + '/code-ai-native-owner/ownership.json');
  assert.equal(owner.nativePid, n.nativePid); assert.equal(owner.nativeIdentity.startTime, n.generation);
  assert.equal(owner.brokerModuleSha256, stage.nativeBrokerSha256);
}
const api = await fleetClient();
const { item } = await api('local', '/queue/items/' + recovery.itemId + '?includeSession=false');
assert.equal(item.nativeSubmission?.turnId, recovery.nativeSubmission.turnId);
assert.equal(item.nativeSubmission?.clientUserMessageId, 'code-ai:' + recovery.itemId);
const receipt = { format: 'code-ai-native-image-input-repair', version: 1, complete: true,
  verifiedAt: new Date().toISOString(), scope: 'main Germany only',
  sessionTitle: 'Artcraft — הטמעת ai', sessionId: recovery.sessionId, itemId: recovery.itemId,
  originalFailure: 'Shared native submission was refused before accepting input',
  reproducedNativeCause: 'local queued attachment is invalid: unsupported image `image/svg+xml`',
  cause: 'UI image classification was incorrectly used as the native inline-image contract',
  fix: 'Send supported raster images inline; retain SVG and other unsupported image formats as inspectable original attached files',
  deployedRelease: stage.candidate, appSha256: stage.request.expectedAppSha256,
  unitTestsPassed: 3, exactNativeContractChecksPassed: 7, nativeVersionUnchanged: '0.163.0',
  liveRecovery: { originalInputNotAcceptedBeforeRetry: true, sameConversationAndQueueItem: true,
    acceptedExactlyOnce: true, svgPreservedAsAttachedFile: true, nativeTurnId: item.nativeSubmission.turnId,
    queueStatus: item.status, error: item.error || null },
  originalBusinessTaskCompletionClaimed: false,
  nativeWritersRestarted: false, activeInputIdsPreserved: activation.preservedActiveInputIds,
  geminiMcpRepairPreserved: true, uiReleaseUnchanged: true, otherServersModified: false,
  originalFailureEvidence: ops + '/original-failure-private.json' };
await fs.writeFile(ops + '/final-receipt.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ complete: true, release: stage.candidate, acceptedExactlyOnce: true, queueStatus: item.status, error: item.error || null }));
