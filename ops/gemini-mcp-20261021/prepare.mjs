import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = '/root/projects/code-ai', ops = root + '/ops/gemini-mcp-20261021';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stagedFile = ops + '/staged.json';
const prior = await fs.readFile(stagedFile, 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (prior) { console.log(prior); process.exit(0); }
const profiles = [];
for (const id of ['developer2', 'developer']) {
  const directory = '/home/' + id + '/code-ai-native-owner';
  const planFile = directory + '/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json';
  const planBytes = await fs.readFile(planFile), plan = JSON.parse(planBytes);
  const custody = JSON.parse(await fs.readFile(directory + '/ownership.json'));
  assert.equal(plan.profileId, id);
  assert.equal(hash(await fs.readFile(plan.brokerModule)), plan.brokerModuleSha256);
  assert.equal(custody.brokerModuleSha256, plan.brokerModuleSha256);
  // The reviewed delta is only delayed restoration. All surrounding accepted
  // native broker code and imports are retained from this exact predecessor.
  assert.equal(plan.brokerModuleSha256, 'e0167f45060bf1e4a8e950632882cadaefd040d0b79d2004e7165032ecebf57a');
  assert.ok((await fs.readFile(plan.runnerModule, 'utf8')).includes('adoptRecordedNative'));
  profiles.push({ id, directory, planFile, planSha256: hash(planBytes), plan,
    runnerSha256: hash(await fs.readFile(plan.runnerModule)) });
}
const candidate = await fs.mkdtemp('/mnt/hdd/code-ai-builds/gemini-mcp-custody-20261021-');
await fs.mkdir(candidate + '/server');
const predecessor = path.dirname(profiles[0].plan.brokerModule);
const files = {};
for (const name of ['codexSharedOwnerBroker.mjs', 'codexRpcDiagnostic.mjs', 'codexNativeTransport.mjs', 'codexSharedHistory.mjs']) {
  const source = name === 'codexSharedOwnerBroker.mjs' ? root + '/server/' + name : predecessor + '/' + name;
  await fs.copyFile(source, candidate + '/server/' + name);
  files['server/' + name] = hash(await fs.readFile(candidate + '/server/' + name));
}
await fs.symlink(await fs.realpath(path.dirname(predecessor) + '/node_modules'), candidate + '/node_modules');
const staged = { format: 'code-ai-gemini-mcp-custody-release', version: 1,
  createdAt: new Date().toISOString(), scope: 'web/main Germany native broker only',
  candidate, files, profiles, brokerSha256: files['server/codexSharedOwnerBroker.mjs'],
  backendRebuildRequired: false, nativeBinaryChanged: false,
  qualification: { brokerUnitTestsPassed: 26, runnerTestsPassed: 20, runnerTestsSkipped: 1,
    exactNativeVersion: '0.163.0', nativeMcpContractChecksPassed: 7,
    realProviderCallsDuringQualification: 0,
    earlyRestoreReproducedMcpElicitationAndRejection: true,
    delayedRestoreContractProducedNoApprovalRequests: true } };
await fs.writeFile(candidate + '/release.json', JSON.stringify(staged, null, 2) + '\n', { mode: 0o600 });
await fs.writeFile(stagedFile, JSON.stringify(staged, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ candidate, brokerSha256: staged.brokerSha256, profiles: profiles.map(p => p.id) }));
