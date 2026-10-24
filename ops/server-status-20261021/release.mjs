import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fleetClient } from '../focus-notifications-20261020/fleet-live.mjs';

const root = '/root/projects/code-ai', ops = root + '/ops/server-status-20261021';
const engine = '/mnt/hdd/code-ai-builds/server-status-engine-20261021-ZbEXaQ/node_modules/systeminformation';
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const digest = async p => hash(await fs.readFile(p));
const save = (p, data) => fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const stageFile = ops + '/staged.json';
const runuser = execFileSync('sh', ['-c', 'command -v runuser'], { encoding: 'utf8' }).trim();
const backendFiles = ['shared/serverStatus.ts', 'server/serverStatus.ts', 'server/serverStatus.test.ts', 'server/serverStatusRoutes.ts', 'server/serverStatusRoutes.test.ts'];
const uiFiles = ['shared/serverStatus.ts', ...['ServerStatusDialog.tsx', 'ServerStatusDialog.test.tsx', 'serverStatusPresentation.ts',
  'serverStatusPresentation.test.ts', 'serverStatusTransport.ts', 'serverStatusTransport.test.ts'].map(name => 'client/src/components/codex/' + name)];

async function tree(dir, rel = '') {
  const files = {};
  for (const entry of (await fs.readdir(dir + '/' + rel, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(rel, entry.name);
    if (entry.isDirectory()) Object.assign(files, await tree(dir, name));
    else { assert.ok(entry.isFile(), 'Source must not contain symlink ' + name); files[name] = await digest(dir + '/' + name); }
  }
  return files;
}
async function own(dir) {
  await fs.chown(dir, 65534, 65534); await fs.chmod(dir, 0o755);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = dir + '/' + entry.name;
    if (entry.isDirectory()) await own(name);
    else { assert.ok(entry.isFile()); await fs.chown(name, 65534, 65534); await fs.chmod(name, 0o644); }
  }
}
function replaceOnce(value, old, next) {
  assert.equal(value.split(old).length, 2, 'Expected one integration anchor: ' + old.slice(0, 70));
  return value.replace(old, next);
}
function projectRoutes(text) {
  text = replaceOnce(text, "import { createWorkModeRouter } from './codexWorkModeRoutes.js';",
    "import { createWorkModeRouter } from './codexWorkModeRoutes.js';\nimport { createServerStatusRouter } from './serverStatusRoutes.js';");
  return replaceOnce(text, 'const router = Router();', 'const router = Router();\nrouter.use(createServerStatusRouter(requireCodexAccess));');
}
async function projectUi(prior) {
  // Accept only this feature's seven additive UI integration hunks.
  let expected = replaceOnce(prior, "import { fetchWithDeploymentRetry } from './deploymentRetry';",
    "import { fetchWithDeploymentRetry } from './deploymentRetry';\nimport type { ServerStatusSnapshot } from '../../../../shared/serverStatus';\nimport { readServerStatus } from './serverStatusTransport';");
  expected = replaceOnce(expected, "const FlowModeDialog = lazy(async () => {", "const ServerStatusDialog = lazy(async () => {\n  const module = await import('./ServerStatusDialog');\n  return { default: module.ServerStatusDialog };\n});\nconst FlowModeDialog = lazy(async () => {");
  expected = replaceOnce(expected, '  const [isTerminalOpen, setIsTerminalOpen] = useState(false);',
    '  const [isTerminalOpen, setIsTerminalOpen] = useState(false);\n  const [isServerStatusOpen, setIsServerStatusOpen] = useState(false);');
  expected = replaceOnce(expected, '  const terminalApi = useMemo<CodexTerminalApi>(() => ({',
    "  const loadServerStatus = useCallback((signal: AbortSignal): Promise<ServerStatusSnapshot> => (\n    readServerStatus((requestSignal) => codexFetch('/api/codex/server-status', { signal: requestSignal }, serverId), signal)\n  ), [serverId]);\n  const terminalApi = useMemo<CodexTerminalApi>(() => ({");
  expected = replaceOnce(expected, 'blocked: isSidebarOpen || isFolderPickerOpen || isFileTreeOpen || isTerminalOpen\n',
    'blocked: isSidebarOpen || isFolderPickerOpen || isFileTreeOpen || isTerminalOpen || isServerStatusOpen\n');
  const actual = await fs.readFile(root + '/client/src/components/codex/CodexMobileApp.tsx', 'utf8');
  const button = actual.match(/                <button\n                  type="button"\n                  data-testid="server-status-button"[\s\S]*?                <\/button>\n/);
  assert.ok(button);
  const anchor = '                  <span className="text-xs font-semibold">טרמינל בתיקייה הפעילה</span>\n                </button>\n';
  expected = replaceOnce(expected, anchor, anchor + button[0]);
  const panel = actual.match(/      \{isServerStatusOpen && \([\s\S]*?      \)\}\n\n/);
  assert.ok(panel);
  expected = replaceOnce(expected, '      {isTerminalOpen && (', panel[0] + '      {isTerminalOpen && (');
  assert.equal(actual, expected, 'Root UI includes unrelated changes; integrate separately');
  return expected;
}
async function dependencies(dir) {
  await fs.mkdir(dir + '/node_modules');
  await fs.chown(dir + '/node_modules', 65534, 65534); await fs.chmod(dir + '/node_modules', 0o755);
  for (const name of await fs.readdir(root + '/node_modules')) {
    if (!['systeminformation', '.vite', '.vite-temp', '.cache'].includes(name))
      await fs.symlink(root + '/node_modules/' + name, dir + '/node_modules/' + name);
  }
  await fs.symlink(dir + '/.deps/systeminformation', dir + '/node_modules/systeminformation');
}
async function runBuild(dir, phase) {
  const logfile = dir + '/qualification/' + phase + '.log';
  await fs.mkdir(path.dirname(logfile), { recursive: true }); await fs.chown(path.dirname(logfile), 65534, 65534);
  const log = await fs.open(logfile, 'a', 0o600), started = Date.now();
  const child = spawn(runuser, ['-u', 'nobody', '--', process.execPath, 'build-server-status.mjs', phase], {
    cwd: dir, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', NODE_OPTIONS: '--max-old-space-size=4096' },
    stdio: ['ignore', log.fd, log.fd],
  });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await log.close(); assert.equal(exitCode, 0, phase + ' build failed: ' + logfile);
  return { phase, passed: true, durationMs: Date.now() - started, logfile };
}

if (process.argv[2] === 'prepare') {
  const baseline = path.dirname(await fs.realpath(root + '/dist'));
  const uiPointer = await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf');
  const predecessor = await json(path.dirname(uiPointer) + '/manifest.json');
  const manifest = await json(baseline + '/release-files.json');
  const candidate = await fs.mkdtemp('/mnt/hdd/code-ai-builds/server-status-api-20261021-');
  for (const [file, expected] of Object.entries(manifest.files)) {
    assert.equal(await digest(baseline + '/' + file), expected, 'Accepted API source changed ' + file);
    await fs.mkdir(path.dirname(candidate + '/' + file), { recursive: true }); await fs.copyFile(baseline + '/' + file, candidate + '/' + file);
  }
  const routes = projectRoutes(await fs.readFile(baseline + '/server/codexRoutes.ts', 'utf8'));
  assert.equal(routes, await fs.readFile(root + '/server/codexRoutes.ts', 'utf8'));
  await fs.writeFile(candidate + '/server/codexRoutes.ts', routes);
  for (const file of backendFiles) { await fs.mkdir(path.dirname(candidate + '/' + file), { recursive: true }); await fs.copyFile(root + '/' + file, candidate + '/' + file); }
  const source = await fs.mkdtemp('/mnt/hdd/code-ai-builds/server-status-ui-source-20261021-');
  await fs.cp(predecessor.capturedSource, source, { recursive: true });
  await fs.writeFile(source + '/client/src/components/codex/CodexMobileApp.tsx', await projectUi(await fs.readFile(predecessor.capturedSource + '/client/src/components/codex/CodexMobileApp.tsx', 'utf8')));
  for (const file of uiFiles) { await fs.mkdir(path.dirname(source + '/' + file), { recursive: true }); await fs.copyFile(root + '/' + file, source + '/' + file); }
  for (const dir of [candidate, source]) {
    await fs.copyFile(ops + '/build.mjs', dir + '/build-server-status.mjs');
    const pkg = await json(dir + '/package.json'); pkg.dependencies.systeminformation = '5.33.16';
    await fs.writeFile(dir + '/package.json', JSON.stringify(pkg, null, 2) + '\n');
    if (await fs.access(dir + '/package-lock.json').then(() => true, () => false)) {
      const lock = await json(dir + '/package-lock.json'); lock.packages[''].dependencies.systeminformation = '5.33.16';
      lock.packages['node_modules/systeminformation'] = (await json(root + '/package-lock.json')).packages['node_modules/systeminformation'];
      await fs.writeFile(dir + '/package-lock.json', JSON.stringify(lock, null, 2) + '\n');
    }
  }
  const files = await tree(source), old = await tree(predecessor.capturedSource);
  assert.ok(Object.keys(old).every(f => f in files), 'No accepted UI source deletion');
  const changed = Object.keys(files).filter(f => files[f] !== old[f]);
  const allowed = [...uiFiles, 'client/src/components/codex/CodexMobileApp.tsx', 'build-server-status.mjs', 'package.json', 'package-lock.json'];
  assert.ok(changed.every(f => allowed.includes(f)), 'Unrelated UI change');
  const sourceSha256 = hash(JSON.stringify(files));
  const workspace = await fs.mkdtemp('/mnt/hdd/code-ai-builds/server-status-ui-build-20261021-');
  await fs.cp(source, workspace, { recursive: true });
  await fs.mkdir(candidate + '/.deps', { recursive: true }); await fs.cp(engine, candidate + '/.deps/systeminformation', { recursive: true });
  await fs.mkdir(workspace + '/.deps', { recursive: true }); await fs.cp(engine, workspace + '/.deps/systeminformation', { recursive: true });
  assert.equal((await json(engine + '/package.json')).version, '5.33.16');
  await own(candidate); await own(workspace);
  await dependencies(candidate); await dependencies(workspace);
  const native = await json(root + '/ops/gemini-mcp-20261021/staged.json');
  assert.equal(await digest(candidate + '/server/codexSharedOwnerBroker.mjs'), native.brokerSha256);
  const stage = { baseline, candidate, uiPointer, predecessor, source, workspace, sourceSha256, files, changed,
    nativeBrokerSha256: native.brokerSha256, baselineManifest: manifest, buildId: randomUUID(), preparedAt: new Date().toISOString() };
  await save(stageFile, stage);
  console.log(JSON.stringify({ prepared: true, candidate, source, workspace, changed }));
} else if (process.argv[2] === 'build') {
  const s = await json(stageFile);
  assert.equal(await fs.realpath(root + '/dist'), s.baseline + '/dist');
  assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'), s.uiPointer);
  s.checks = await Promise.all([runBuild(s.candidate, 'backend'), runBuild(s.workspace, 'ui')]);
  const release = await json(s.candidate + '/release.json');
  Object.assign(release, { version: path.basename(s.candidate), builtAt: new Date().toISOString(), buildId: s.buildId,
    buildType: 'main-server-isolated-scoped-build', builder: 'user-server', beamAttested: false });
  await fs.writeFile(s.candidate + '/release.json', JSON.stringify(release, null, 2) + '\n');
  const extra = ['build-server-status.mjs', ...backendFiles, ...Object.keys(await tree(s.candidate + '/.deps')).map(f => '.deps/' + f),
    ...Object.keys(await tree(s.candidate + '/qualification')).map(f => 'qualification/' + f)];
  const names = [...new Set([...Object.keys(s.baselineManifest.files), ...extra])];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await digest(s.candidate + '/' + name)])));
  await fs.writeFile(s.candidate + '/release-files.json', JSON.stringify({ format: 'code-ai-release-files', version: 1, files }, null, 2) + '\n');
  const request = await json(s.baseline + '/fleet-request.json');
  Object.assign(request, { candidate: s.candidate, baseline: s.baseline, buildId: s.buildId, releaseOrder: String(Date.now()),
    attemptId: 'server-status-' + randomUUID(), ownerAuthorizedInterruption: true,
    expectedBaselineSha256: await digest(s.baseline + '/dist/server.js'), expectedServerSha256: files['dist/server.js'], expectedAppSha256: files['dist/app.mjs'],
    uploadBaselineModule: s.baseline + '/dist/server.js', uploadBaselineSha256: await digest(s.baseline + '/dist/server.js') });
  delete request.featureEnvironmentFile;
  await save(s.candidate + '/fleet-request.json', request);
  const preflight = JSON.parse(execFileSync(request.nodeExecutable, [s.candidate + '/install.mjs', 'preflight', s.candidate + '/fleet-request.json'], { cwd: s.candidate, encoding: 'utf8', timeout: 120000 }));
  assert.equal(preflight.prepared, true);
  Object.assign(s, { passed: true, request, preflight, builtAt: new Date().toISOString() }); await save(stageFile, s);
  console.log(JSON.stringify({ passed: true, candidate: s.candidate, checks: s.checks, preflightPassed: true }));
} else if (process.argv[2] === 'publish-ui') {
  const s = await json(stageFile); assert.equal(s.passed, true);
  assert.equal(await fs.realpath(root + '/dist'), s.candidate + '/dist');
  const api = await fleetClient(), snapshot = await api('local', '/server-status');
  assert.equal(snapshot.version, 1); assert.ok(snapshot.hostname && snapshot.cpu && snapshot.memory && snapshot.storage && snapshot.network);
  const capture = { source: s.source, sourceSha256: s.sourceSha256, baseline: s.candidate, activationBackendBaseline: s.candidate,
    predecessorPointer: s.uiPointer, predecessor: s.predecessor, changed: s.changed, files: s.files, delivery: 'owner-authorized-local', frontendOnly: true };
  await save(ops + '/capture.json', capture);
  const files = Object.fromEntries(Object.entries(await tree(s.workspace + '/dist/public')).map(([f, h]) => ['dist/public/' + f, h]));
  await save(ops + '/manual-build.json', { passed: true, beamBuild: false, sourceSha256: s.sourceSha256,
    authorization: 'פרוס במסלול הישיר והידני', buildId: s.buildId, workspace: s.workspace, files,
    builder: 'user-server', beamAttested: false, buildType: 'owner-authorized-main-server-isolated-ui-build' });
  await save(ops + '/live-save.json', { passed: true, source: s.source, readOnly: true, host: snapshot.hostname, apiContractVersion: snapshot.version });
  const env = { ...process.env, CODE_AI_UI_RELEASE_OPS: ops };
  const publish = root + '/ops/work-mode-save-20261020/publish.mjs';
  execFileSync(process.execPath, [publish, 'prepare'], { stdio: 'inherit', env });
  execFileSync(process.execPath, [root + '/ops/work-modes-ui-20261020/static-preflight.mjs', '/var/www/code-ai-ui/releases/' + s.sourceSha256.slice(0, 12), ops], { stdio: 'inherit' });
  execFileSync('flock', ['-n', '/run/code-ai-ui-deployment.lock', process.execPath, publish, 'activate'], { stdio: 'pipe', env });
  await fs.rename(ops + '/final-receipt.json', ops + '/ui-activation.json');
  console.log(JSON.stringify({ installed: true, uiRelease: s.sourceSha256.slice(0, 12), apiHostname: snapshot.hostname }));
} else if (process.argv[2] === 'activate-ui') {
  const s = await json(stageFile), preview = await json(ops + '/preview-browser.json');
  assert.equal(s.passed, true); assert.equal(preview.passed, true);
  assert.equal(await fs.realpath(root + '/dist'), s.candidate + '/dist');
  assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'), s.uiPointer);
  // The previous transaction rolled back on host->Cloudflare IPv4 timeout.
  // IPv6 TLS/HTTP was verified on both public aliases. Prefer that family in
  // this validation process only; do not change server or machine networking.
  const env = { ...process.env, CODE_AI_UI_RELEASE_OPS: ops };
  execFileSync('flock', ['-n', '/run/code-ai-ui-deployment.lock', process.execPath, '--dns-result-order=ipv6first',
    root + '/ops/work-mode-save-20261020/publish.mjs', 'activate'], { stdio: 'pipe', env });
  await fs.rename(ops + '/final-receipt.json', ops + '/ui-activation.json');
  console.log(JSON.stringify({ installed: true, uiRelease: s.sourceSha256.slice(0, 12), validationTransport: 'public TLS, IPv6 preferred' }));
} else throw Error('Expected prepare, build, publish-ui, or activate-ui');
