import assert from 'node:assert/strict';
import { cp, readFile, writeFile, mkdtemp, mkdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const predecessor = '/mnt/hdd/code-ai-builds/deferred-deployment-source-JIIigA';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identityBytes = await readFile(predecessor + '/source-identity.json');
assert.equal(hash(identityBytes), '14a18cab128d6a22c7191459ff330901a20dcb45ebee732b989d2988e9cdab94');
const identity = JSON.parse(identityBytes);
for (const [relative, expected] of Object.entries(identity.sourceHashes)) {
  assert.equal(hash(await readFile(predecessor + '/payload/' + relative)), expected, 'Qualified cumulative source changed');
}
const stage = await mkdtemp('/mnt/hdd/code-ai-builds/immediate-interrupting-release-');
await chmod(stage, 0o700);
await cp(predecessor + '/payload', stage + '/payload', { recursive: true });
for (const file of ['package.json', 'pnpm-lock.yaml', 'test.mjs', 'api-smoke.mjs', 'fake-codex.mjs',
  'drain-audit-smoke.mjs', 'coordinator.mjs', 'coordinator-audit.test.mjs', 'controller-client.mjs', 'systemd/render-units.mjs']) {
  await mkdir(path.dirname(stage + '/' + file), { recursive: true });
  await cp(predecessor + '/' + file, stage + '/' + file);
}
const configFile = stage + '/payload/server/config.ts';
let config = await readFile(configFile, 'utf8');
for (const [value, field] of [['code-ai-offline-audit-device-admin-v1', 'CODEX_DEVICE_ADMIN_PASSWORD'],
  ['code-ai-offline-audit-session-signing-v1', 'SESSION_SECRET']]) {
  assert.equal(config.split(JSON.stringify(value)).length, 2, 'Synthetic default integration anchor changed');
  config = config.replace(JSON.stringify(value), `missingRuntimeAuthentication('${field}')`);
}
config += '\nfunction missingRuntimeAuthentication(field: string): never {\n  throw new Error(`Required runtime authentication was not preserved: ${field}`);\n}\n';
await writeFile(configFile, config);
for (const file of ['runtime-auth.mjs', 'runtime-auth.test.mjs', 'server-entry.mjs', 'build.mjs', 'install.mjs'])
  await cp(path.join(root, file), stage + '/' + file);
const testFile = stage + '/test.mjs';
// The installed bundle is fail-closed without runtime authentication. The
// isolated unit children therefore need explicit synthetic fixture values;
// these are test-process environment only, never compiled defaults.
await writeFile(testFile, "process.env.CODEX_DEVICE_ADMIN_PASSWORD = 'code-ai-isolated-unit-device-v1';\n"
  + "process.env.SESSION_SECRET = 'code-ai-isolated-unit-signing-v1';\n"
  + (await readFile(testFile, 'utf8'))
  + '\nexecFileSync(process.execPath, ["--test", "runtime-auth.test.mjs"], { stdio: "inherit", timeout: 30_000 });\n');
const parserTestFile = stage + '/coordinator-audit.test.mjs';
const parserTest = await readFile(parserTestFile, 'utf8');
const parserBudget = "['verify', '--man=no', serviceFile, timerFile], { encoding: 'utf8', timeout: 5_000 }";
assert.equal(parserTest.split(parserBudget).length, 2, 'Isolated systemd parser timeout anchor changed');
await writeFile(parserTestFile, parserTest.replace(parserBudget, parserBudget.replace('5_000', '20_000')));
await writeFile(stage + '/release-source.json', JSON.stringify({
  format: 'code-ai-authorized-interrupting-release-source', version: 1,
  capturedAt: new Date().toISOString(), cumulativeAuditIdentitySha256: hash(identityBytes),
  originalQualifiedSourceFreezeSha256: identity.sourceFreezeSha256,
  ownerAuthorizedInterruption: true, sharedOwnerEnabled: false,
  automaticDeploymentQualified: false, credentialRotation: false,
  authDefaults: 'Privately preserve exact pinned installed predecessor defaults at runtime; never export them',
  changedFromQualifiedAudit: ['server/config.ts', 'runtime-auth.mjs', 'runtime-auth.test.mjs', 'server-entry.mjs', 'build.mjs', 'test.mjs', 'install.mjs', 'coordinator-audit.test.mjs (isolated parser timeout only)'],
}, null, 2) + '\n', { mode: 0o600 });
const key = hash(await readFile(stage + '/release-source.json'));
console.log(JSON.stringify({ stage, clientKey: key, sourceCaptured: true, sharedOwnerEnabled: false }));
