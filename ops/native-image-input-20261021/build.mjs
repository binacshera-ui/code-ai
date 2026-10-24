import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = '/root/projects/code-ai', ops = root + '/ops/native-image-input-20261021';
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async p => hash(await fs.readFile(p));
const file = ops + '/staged.json';
if (process.argv[2] === 'prepare') {
  const baseline = path.dirname(await fs.realpath(root + '/dist'));
  const manifest = await json(baseline + '/release-files.json');
  const candidate = await fs.mkdtemp('/mnt/hdd/code-ai-builds/native-image-input-20261021-');
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.equal(await digest(baseline + '/' + name), expected, 'Accepted predecessor changed: ' + name);
    await fs.mkdir(path.dirname(candidate + '/' + name), { recursive: true });
    await fs.copyFile(baseline + '/' + name, candidate + '/' + name);
  }
  await fs.symlink(await fs.realpath(baseline + '/node_modules'), candidate + '/node_modules');
  for (const name of ['codexAttachmentInputs.ts', 'codexAttachmentInputs.test.ts']) await fs.copyFile(root + '/server/' + name, candidate + '/server/' + name);
  // Retain the independently accepted MCP-custody repair in the cumulative
  // source package. This release does not replace/restart either native owner.
  const native = await json(root + '/ops/gemini-mcp-20261021/staged.json');
  assert.equal(await digest(root + '/server/codexSharedOwnerBroker.mjs'), native.brokerSha256);
  await fs.copyFile(root + '/server/codexSharedOwnerBroker.mjs', candidate + '/server/codexSharedOwnerBroker.mjs');
  const state = { format: 'code-ai-native-image-input-release', version: 1, baseline, candidate,
    nativeBrokerSha256: native.brokerSha256, baselineManifest: manifest,
    uiPointer: await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),
    sourcePredecessorSha256: await digest(candidate + '/server/codexService.ts'),
    preparedAt: new Date().toISOString(), buildId: randomUUID() };
  await fs.writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ baseline, candidate }));
} else if (process.argv[2] === 'build') {
  const s = await json(file), { candidate, baseline } = s;
  assert.equal(await fs.realpath(root + '/dist'), baseline + '/dist');
  assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'), s.uiPointer);
  const text = await fs.readFile(candidate + '/server/codexService.ts', 'utf8');
  assert.ok(text.includes('attachments.filter(isCodexInlineImage)'));
  const original = await fs.readFile(baseline + '/server/codexService.ts', 'utf8');
  const expected = original.replace("import { resolveCodexExecutionSelection } from './codexExecutionSelection.js';",
    "import { resolveCodexExecutionSelection } from './codexExecutionSelection.js';\nimport { isCodexInlineImage } from './codexAttachmentInputs.js';")
    .replace('attachments.filter((attachment) => attachment.isImage)', 'attachments.filter(isCodexInlineImage)')
    .replace("const typeLabel = attachment.isImage ? 'image' : 'file';", "const typeLabel = isCodexInlineImage(attachment) ? 'image' : 'file';");
  assert.equal(text, expected, 'Only the reviewed attachment adaptation may change');
  await build({ entryPoints: [candidate + '/server/codexAttachmentInputs.test.ts'], bundle: true,
    platform: 'node', format: 'esm', outfile: candidate + '/qualification/native-image-input.test.mjs' });
  const tests = execFileSync(process.execPath, ['--test', candidate + '/qualification/native-image-input.test.mjs'], { encoding: 'utf8' });
  await fs.writeFile(candidate + '/qualification/native-image-input-tests.log', tests);
  await build({ entryPoints: [candidate + '/server/index.ts'], bundle: true, platform: 'node', format: 'esm',
    outfile: candidate + '/dist/app.mjs', external: ['express', 'multer', 'cors', 'express-session', 'connect-pg-simple', 'pg', 'node-pty', 'ws'] });
  const release = await json(candidate + '/release.json');
  Object.assign(release, { version: path.basename(candidate), builtAt: new Date().toISOString(), buildId: s.buildId,
    buildType: 'main-server-isolated-scoped-build', builder: 'user-server', beamAttested: false });
  await fs.writeFile(candidate + '/release.json', JSON.stringify(release, null, 2) + '\n');
  const names = [...new Set([...Object.keys(s.baselineManifest.files), 'server/codexAttachmentInputs.ts',
    'server/codexAttachmentInputs.test.ts', 'qualification/native-image-input.test.mjs', 'qualification/native-image-input-tests.log'])];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await digest(candidate + '/' + name)])));
  await fs.writeFile(candidate + '/release-files.json', JSON.stringify({ format: 'code-ai-release-files', version: 1, files }, null, 2) + '\n');
  const request = await json(baseline + '/fleet-request.json');
  Object.assign(request, { candidate, baseline, buildId: s.buildId, releaseOrder: String(Date.now()),
    attemptId: 'native-image-' + randomUUID(), ownerAuthorizedInterruption: true,
    expectedBaselineSha256: await digest(baseline + '/dist/server.js'), expectedServerSha256: files['dist/server.js'], expectedAppSha256: files['dist/app.mjs'],
    uploadBaselineModule: baseline + '/dist/server.js', uploadBaselineSha256: await digest(baseline + '/dist/server.js') });
  delete request.featureEnvironmentFile;
  await fs.writeFile(candidate + '/fleet-request.json', JSON.stringify(request, null, 2) + '\n', { mode: 0o600 });
  const preflight = JSON.parse(execFileSync(request.nodeExecutable, [candidate + '/install.mjs', 'preflight', candidate + '/fleet-request.json'],
    { cwd: candidate, encoding: 'utf8', timeout: 120000 }));
  assert.equal(preflight.prepared, true);
  Object.assign(s, { passed: true, testsPassed: 3, request, preflight, files, builtAt: new Date().toISOString() });
  await fs.writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, candidate, testsPassed: 3, preflightPassed: true }));
} else throw Error('Expected prepare or build');
