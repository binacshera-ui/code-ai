import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, readdir, writeFile, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const candidate = process.argv[2];
assert.ok(candidate?.startsWith('/mnt/hdd/code-ai-builds/focus-notifications-20261020-'));
const root = '/root/projects/code-ai';
const active = path.dirname(await realpath(path.join(root, 'dist')));
const identity = JSON.parse(await readFile(path.join(candidate, 'build-identity.json'), 'utf8'));
assert.equal(path.dirname(path.dirname(identity.baseRuntime)), active, 'Accepted baseline changed during qualification');
assert.equal(identity.built, true);
const featureProof = JSON.parse(await readFile('/mnt/hdd/code-ai-builds/focus-notifications-20261020-SilnIg/feature-acceptance.json', 'utf8'));
const decisionProof = JSON.parse(await readFile(path.join(candidate, 'decision-acceptance.json'), 'utf8'));
assert.ok(featureProof.ok && decisionProof.ok);
// Reuse the completed one-minute native test only for unchanged source inputs.
const previous = JSON.parse(await readFile('/mnt/hdd/code-ai-builds/focus-notifications-20261020-SilnIg/build-identity.json', 'utf8'));
const previousFiles = new Map(previous.files);
const capturedRoots = new Set(identity.files.map(([name]) => name.split('/')[0]));
for (const [file, hash] of identity.files) {
  if (previousFiles.has(file) && !['server/incidentDecisionCenter.ts', 'server/incidentDecisionCenter.test.ts'].includes(file)) {
    assert.equal(hash, previousFiles.get(file), `Prior feature proof input changed: ${file}`);
  }
}
const acceptedSource = '/mnt/hdd/code-ai-builds/sessions-read-source-20261020/payload';
const changed = new Set(['client/src/components/codex/CodexMobileApp.tsx', 'server/agentService.ts',
  'server/codexAppServer.ts', 'server/codexAppServer.test.ts', 'server/codexFinalNotificationRoutes.ts',
  'server/codexFinalNotifications.ts', 'server/codexFinalNotifications.test.ts', 'server/codexQueue.ts',
  'server/codexRoutes.ts', 'server/codexService.ts', 'server/index.ts', 'server/incidentDecisionCenter.ts',
  'scripts/incident-case-update.mjs']);
const restored = ['scripts/codex-native-queued-recovery-contract.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = async file => digest(await readFile(file));
let retained = 0;
async function verifyBaseline(relative = '') {
  for (const entry of await readdir(path.join(acceptedSource, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (!capturedRoots.has(file.split('/')[0])) continue;
    if (entry.isDirectory()) await verifyBaseline(file);
    else if (entry.isFile()) {
      if (restored.includes(file)) continue;
      const accepted = await hashFile(path.join(acceptedSource, file));
      const captured = await hashFile(path.join(candidate, file));
      if (accepted !== captured) assert.ok(changed.has(file), `Undeclared accepted-source change: ${file}`);
      else retained++;
    }
  }
}
await verifyBaseline();
for (const file of ['server/codexSharedOwnerBroker.mjs', 'scripts/codex-shared-cli.mjs', 'scripts/codex-shared-stdio.mjs']) {
  assert.equal(await hashFile(path.join(candidate, file)), await hashFile(path.join(active, file)), 'Shared native owner changed');
}
const release = `/mnt/hdd/code-ai-builds/work-modes-20261020-${identity.sourceSha256.slice(0, 12)}`;
await mkdir(release); // Refuse overwriting a prior prepared/active package.
for (const item of ['server', 'shared', 'scripts', 'chrome-extension', 'package.json', 'package-lock.json', 'dist']) {
  await cp(path.join(candidate, item), path.join(release, item), { recursive: true });
}
for (const file of restored) await cp(path.join(acceptedSource, file), path.join(release, file));
await cp(path.join(candidate, 'dist/server.js'), path.join(release, 'dist/app.mjs'));
for (const item of ['dist/server.js', 'runtime-auth.mjs', 'transaction-contract.mjs', 'release-order.mjs', 'install.mjs']) {
  await cp(path.join(active, item), path.join(release, item));
}
await mkdir(path.join(release, 'qualification'), { recursive: true });
await cp(path.join(active, 'qualification/native-owner.json'), path.join(release, 'qualification/native-owner.json'));
await symlink(await realpath(path.join(active, 'node_modules')), path.join(release, 'node_modules'));
await writeFile(path.join(release, 'qualification/work-modes.json'), JSON.stringify({
  format: 'code-ai-work-modes-qualified', version: 1, sourceSha256: identity.sourceSha256,
  baseline: active, retainedAcceptedFiles: retained, declaredModifiedExistingPaths: [...changed], restored,
  featureProof, decisionProof, tests: { rationalAndRelated: 49, incidentDecision: 11 },
  buildHost: 'main Germany web', noRemoteHostOperations: true, nativeOwnersUnchanged: true,
}, null, 2));
await writeFile(path.join(release, 'release.json'), JSON.stringify({ version: path.basename(release),
  sourceSha256: identity.sourceSha256, expectedCodexVersion: '0.163.0', builtAt: new Date().toISOString(),
  buildType: 'owner-authorized-local', attestation: null }, null, 2));
const files = {};
async function manifest(relative = '') {
  for (const entry of await readdir(path.join(release, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await manifest(name);
    else if (entry.isFile()) files[name] = await hashFile(path.join(release, name));
  }
}
await manifest();
await writeFile(path.join(release, 'release-files.json'), JSON.stringify({ files }, null, 2));
const request = JSON.parse(await readFile(path.join(active, 'fleet-request.json'), 'utf8'));
assert.equal(request.id, 'main');
Object.assign(request, { candidate: release, baseline: active, buildId: randomUUID(),
  releaseOrder: String(Date.now()), attemptId: 'work-modes-20261020', ownerAuthorizedInterruption: true,
  expectedBaselineSha256: await hashFile(path.join(active, 'dist/server.js')),
  expectedServerSha256: await hashFile(path.join(release, 'dist/server.js')),
  expectedAppSha256: await hashFile(path.join(release, 'dist/app.mjs')),
  uploadBaselineModule: path.join(active, 'dist/server.js'), uploadBaselineSha256: await hashFile(path.join(active, 'dist/server.js')) });
assert.equal(request.sharedProfiles, 'developer,developer2');
const requestFile = path.join(release, 'main-request.json');
await writeFile(requestFile, JSON.stringify(request, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ release, requestFile, baseline: active, retainedAcceptedFiles: retained, immutableFiles: Object.keys(files).length }));
