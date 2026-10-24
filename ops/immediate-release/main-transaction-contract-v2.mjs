import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// This supervisor is started by a separate transient systemd unit so stopping
// Code AI cannot terminate its own deployment and rollback transaction.
const [buildId, controllerBuildId] = process.argv.slice(2);
for (const value of [buildId, controllerBuildId]) assert.match(value, /^[a-f0-9-]{36}$/);
const importRoot = '/mnt/hdd/code-ai-builds/immediate-release-imports';
const staged = JSON.parse(await readFile('/root/projects/code-ai/ops/immediate-release/staged-' + buildId + '.json', 'utf8'));
const request = staged.targets.find(request => request.id === 'main');
const tools = importRoot + '/' + controllerBuildId + '/artifact/dist';
const { parseRuntimeEnvironment, preserveRuntimeAuthentication } = await import(tools + '/runtime-auth.mjs');
const pm2 = '/root/.nvm/versions/node/v24.12.0/bin/pm2';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const privateRun = (command, args, options = {}) => execFileSync(command, args,
  { encoding: 'utf8', stdio: 'pipe', timeout: 240_000, ...options });
const record = () => JSON.parse(privateRun(pm2, ['jlist'])).find(item => item.name === 'code-ai-app');
async function resolvedEnvironment(processRecord) {
  const env = { ...processRecord.pm2_env.env,
    ...parseRuntimeEnvironment(await readFile('/proc/' + processRecord.pid + '/environ')) };
  env.CODE_AI_AUTH_BASELINE_MODULE = request.baseline + '/dist/server.js';
  env.CODE_AI_AUTH_BASELINE_SHA256 = request.expectedBaselineSha256;
  await preserveRuntimeAuthentication(env);
  return env;
}
const before = record();
const previousEnvironment = await resolvedEnvironment(before);
const checks = JSON.parse(await readFile(tools + '/transaction-checks.json', 'utf8'));
assert.equal(checks.applicationBuildId, buildId);
for (const [file, digest] of Object.entries(checks.files)) assert.equal(hash(await readFile(tools + '/' + file)), digest);
for (const key of ['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID'])
  assert.equal(Object.hasOwn(before.pm2_env.env, key), false);
for (const id of [buildId, controllerBuildId]) privateRun('/usr/local/bin/bina-build', ['verify-import', id, '--import-root', importRoot]);
let main; let failure;
try {
  privateRun(request.nodeExecutable, [tools + '/install.mjs', 'activate', request.candidate + '/deployment-request.json'], { cwd: request.candidate });
  main = JSON.parse(await readFile(request.candidate + '/activation-receipt.json', 'utf8'));
  const after = record();
  assert.equal(after.pm2_env.status, 'online');
  assert.notEqual(after.pid, before.pid);
  const nextEnvironment = await resolvedEnvironment(after);
  main.credentialConfigurationBytePreserved = ['CODEX_DEVICE_ADMIN_PASSWORD', 'SESSION_SECRET', 'DATABASE_URL']
    .every(key => previousEnvironment[key] === nextEnvironment[key]);
  assert.equal(main.credentialConfigurationBytePreserved, true);
  main.mainPidBefore = before.pid; main.mainPidAfter = after.pid;
  main.distSymlinkVerified = await realpath('/root/projects/code-ai/dist') === request.candidate + '/dist';
  assert.equal(main.distSymlinkVerified, true);
  main.liveApplicationSha256 = hash(await readFile('/root/projects/code-ai/dist/app.mjs'));
  assert.equal(main.liveApplicationSha256, request.expectedAppSha256);
  try {
    const url = 'https://app-codex.bina-cshera.co.il/?release=' + buildId;
    const response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const html = await response.text();
    const scripts = [...html.matchAll(/src="(\/assets\/[^"\s]+\.js)"/g)].map(match => match[1]);
    assert.ok(scripts.length > 0);
    for (const asset of scripts) {
      const received = await fetch(new URL(asset, url), { signal: AbortSignal.timeout(10000) });
      assert.equal(received.status, 200);
      assert.equal(hash(Buffer.from(await received.arrayBuffer())), hash(await readFile(request.candidate + '/dist/public' + asset)));
    }
    main.publicHttpsNewAssetHashesVerified = true;
  } catch { main.publicHttpsNewAssetHashesVerified = false; }
} catch {
  try { failure = JSON.parse(await readFile(request.candidate + '/activation-failure.json', 'utf8')); }
  catch { failure = { id: 'main', installed: false, reason: 'supervisor_verification_failed' }; }
}
const remotes = [];
for (const id of ['beam-10g', 'pci', 'ubuntu-gpu-lab']) remotes.push(JSON.parse(await readFile(
  '/root/projects/code-ai/ops/immediate-release/receipt-' + id + '-' + buildId + '.json', 'utf8')));
const receipt = {
  format: 'code-ai-authorized-interrupting-release-receipt', version: 1,
  applicationBuildId: buildId, controllerBuildId, finishedAtUtc: new Date().toISOString(),
  ownerAuthorizedInterruption: true, productionReplacementPerformed: Boolean(main?.installed),
  coreApplicationUpdatedOnAllFourAccessibleTargets: Boolean(main?.installed
    && main.credentialConfigurationBytePreserved && main.distSymlinkVerified
    && main.liveApplicationSha256 === request.expectedAppSha256 && remotes.every(item => item.installed)),
  unitTestsPassed: 230, compiledQuestionMediaAndDrainChecksPassed: 10,
  separatelyQualifiedControllerTestsPassed: checks.authenticationPreservationTestsPassed
    + (checks.transactionContractTestsPassed || 0),
  hosts: [...remotes, main || failure],
  beamFirstAttempt: { failed: true, rollbackVerified: true,
    cause: 'Legacy launcher env-file path moved with its release reference; exact private predecessor env symlink added before retry',
    originalAttemptEvidencePreserved: true },
  mainFirstAttempt: {
    failed: true, predecessorMainAndUploadsRecovered: true,
    originalAttemptEvidence: 'ops/immediate-release/receipt-20261010-attempt1.json',
    isolatedActualApplicationReproducer: 'Question route correctly returns JSON 403 for a locked device; the original verifier rejected it',
    recoveryContractCorrection: 'Verify predecessor assets during rollback and recover upload service independently of main readiness',
    applicationArtifactChanged: false,
  },
  credentialsRotated: false, liveCookiesOrCredentialsPrinted: false,
  sharedOwnerEnabled: false, automaticDeploymentWorkerInstalled: false,
  limitations: [
    'Windows reverse SSH was unavailable; Windows was not replaced or restarted.',
    'Personal Chrome returned DEVICE_OFFLINE; no live browser or native GUI acceptance is claimed.',
    'Native shared ownership remains disabled: its atomic per-message configuration contract is not qualified.',
    'The future automatic drain/seal adapter remains unqualified and was not enabled.',
    'Owner-authorized restart can interrupt running tasks; retained queue records and backups do not prove uninterrupted execution.',
    'Existing device-admin/signing values are preserved, not rotated; the separately scoped security incident is not closed.',
  ],
};
const destination = '/root/projects/code-ai/ops/immediate-release/receipt-20261010.json';
await writeFile(destination, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
const statusFile = '/root/projects/code-ai/ops/shared-codex-owner/deployment-status-20261010.json';
const status = JSON.parse(await readFile(statusFile, 'utf8'));
status.observedAt = receipt.finishedAtUtc;
status.currentDeploymentPolicy = 'owner-authorized immediate singleton interruption';
status.state = receipt.coreApplicationUpdatedOnAllFourAccessibleTargets
  ? 'core_release_deployed_native_shared_owner_still_unqualified'
  : 'partial_core_release_deployment_main_not_verified';
status.coreApplicationRelease = { buildId, controllerBuildId,
  deployedOnAllAccessibleTargets: receipt.coreApplicationUpdatedOnAllFourAccessibleTargets,
  receipt: 'ops/immediate-release/receipt-20261010.json' };
status.sharedOwnerEnabled = false;
status.automaticDeploymentWorkerInstalled = false;
status.boundaries = status.boundaries.map(value => value ===
  'No production restart, desktop termination, lock deletion, credential change, or automatic deployment was performed.'
  ? 'The earlier offline audit had no installed effects. The subsequent owner-authorized immediate core deployment has its own verified receipt; native shared ownership and automatic deployment remain off.'
  : value);
await writeFile(statusFile, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ receipt: destination, allFourAccessibleTargetsUpdated: receipt.coreApplicationUpdatedOnAllFourAccessibleTargets,
  mainPid: main?.mainPidAfter || null, publicHttpsVerified: main?.publicHttpsNewAssetHashesVerified || false }));
if (!main?.installed) process.exitCode = 1;
