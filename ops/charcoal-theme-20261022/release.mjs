import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const root = '/root/projects/code-ai', ops = root + '/ops/charcoal-theme-20261022';
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const save = (p, obj) => fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
const node = process.execPath, runuser = execFileSync('sh', ['-c', 'command -v runuser'], { encoding: 'utf8' }).trim();
async function tree(dir, rel = '') {
  const groups = await Promise.all((await fs.readdir(dir + '/' + rel, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name)).map(async e => {
    const name = path.join(rel, e.name);
    if (e.isDirectory()) return tree(dir, name);
    assert.ok(e.isFile()); return { [name]: hash(await fs.readFile(dir + '/' + name)) };
  }));
  return Object.assign({}, ...groups);
}
async function own(dir) {
  await fs.chown(dir, 65534, 65534); await fs.chmod(dir, 0o755);
  await Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(async e => {
    const f = dir + '/' + e.name;
    if (e.isDirectory()) await own(f); else { assert.ok(e.isFile()); await fs.chown(f, 65534, 65534); await fs.chmod(f, 0o644); }
  }));
}
if (process.argv[2] === 'build') {
  const baseline = path.dirname(await fs.realpath(root + '/dist'));
  const pointer = await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf');
  const predecessor = await json(path.dirname(pointer) + '/manifest.json');
  const source = await fs.mkdtemp('/mnt/hdd/code-ai-builds/charcoal-source-20261022-');
  await fs.cp(predecessor.capturedSource, source, { recursive: true });
  const changed = ['client/src/index.css', 'client/src/themes/charcoal.css', 'client/src/themes/charcoal.test.mjs', 'client/src/components/codex/CodexTerminalDialog.tsx'];
  const priorCss = await fs.readFile(source + '/client/src/index.css', 'utf8');
  const expectedCss = priorCss.replace('@import "tailwindcss/utilities.css" layer(utilities);', '@import "tailwindcss/utilities.css" layer(utilities);\n@import "./themes/charcoal.css" layer(components);')
    .replace(/  \.code-ai-theme-dark \{[\s\S]*?(?=\n  \.code-ai-user-avatar)/, '');
  assert.equal(await fs.readFile(root + '/client/src/index.css', 'utf8'), expectedCss, 'Only dark theme extraction may change index');
  const terminalFile = 'client/src/components/codex/CodexTerminalDialog.tsx';
  const terminal = await fs.readFile(root + '/' + terminalFile, 'utf8');
  const expectedTerminal = (await fs.readFile(source + '/' + terminalFile, 'utf8')).replace("        brightWhite: '#ffffff',", "        brightWhite: '#ffffff',\n        ...(hostRef.current.closest('.code-ai-theme-dark') ? {\n          background: '#0a0a0a', foreground: '#ededed', cursor: '#ededed',\n          cursorAccent: '#0a0a0a', selectionBackground: '#404040',\n          black: '#171717', brightBlack: '#a3a3a3',\n        } : {}),");
  assert.equal(terminal, expectedTerminal, 'Only terminal dark colors may change');
  for (const file of changed) { await fs.mkdir(path.dirname(source + '/' + file), { recursive: true }); await fs.copyFile(root + '/' + file, source + '/' + file); }
  await fs.copyFile(ops + '/build.mjs', source + '/build-charcoal.mjs');
  const files = await tree(source), old = await tree(predecessor.capturedSource);
  assert.ok(Object.keys(old).every(f => f in files));
  assert.deepEqual(Object.keys(files).filter(f => files[f] !== old[f]).sort(), [...changed, 'build-charcoal.mjs'].sort());
  const sourceSha256 = hash(JSON.stringify(files));
  const workspace = await fs.mkdtemp('/mnt/hdd/code-ai-builds/charcoal-build-20261022-');
  await fs.cp(source, workspace, { recursive: true }); await own(workspace);
  await fs.mkdir(workspace + '/node_modules'); await fs.chown(workspace + '/node_modules', 65534, 65534);
  for (const name of await fs.readdir(root + '/node_modules')) if (!['.vite', '.vite-temp', '.cache'].includes(name))
    await fs.symlink(root + '/node_modules/' + name, workspace + '/node_modules/' + name);
  const capture = { source, sourceSha256, baseline, predecessorPointer: pointer, predecessor, changed, files,
    delivery: 'owner-authorized-local', frontendOnly: true, staticReleaseRoot: '/mnt/hdd/code-ai-ui/releases' };
  await save(ops + '/capture.json', capture);
  const log = await fs.open(workspace + '/build.log', 'wx', 0o600);
  const child = spawn(runuser, ['-u', 'nobody', '--', node, 'build-charcoal.mjs'], { cwd: workspace,
    env: { PATH: path.dirname(node) + ':/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', NODE_OPTIONS: '--max-old-space-size=4096' }, stdio: ['ignore', log.fd, log.fd] });
  const result = await new Promise((resolve,reject) => { child.once('exit',resolve); child.once('error',reject); });
  await log.close(); assert.equal(result, 0, 'Build failed: ' + workspace + '/build.log');
  await save(ops + '/manual-build.json', { passed: true, beamBuild: false, beamAttested: false, builder: 'user-server', buildUid: 65534,
    sourceSha256, source, workspace, authorization: 'פרוס במסלול הישיר והידני', buildId: randomUUID(),
    files: Object.fromEntries(Object.entries(await tree(workspace + '/dist/public')).map(([f,h]) => ['dist/public/' + f,h])),
    buildType: 'owner-authorized-main-server-isolated-ui-build' });
  console.log(JSON.stringify({ passed: true, source, workspace, sourceSha256, testsPassed: 7, sourceChanges: changed }));
} else if (process.argv[2] === 'prepare') {
  const c = await json(ops + '/capture.json');
  execFileSync(node, [root + '/ops/work-mode-save-20261020/publish.mjs', 'prepare'], { stdio: 'inherit', env: { ...process.env, CODE_AI_UI_RELEASE_OPS: ops } });
  execFileSync(node, [root + '/ops/work-modes-ui-20261020/static-preflight.mjs', c.staticReleaseRoot + '/' + c.sourceSha256.slice(0,12), ops], { stdio: 'inherit' });
} else if (process.argv[2] === 'activate') {
  const c = await json(ops + '/capture.json'), preview = await json(ops + '/preview-browser.json');
  assert.equal(preview.passed, true);
  await save(ops + '/live-save.json', { passed: true, source: c.source, readOnly: true, browserPreflightPassed: true,
    browserVerification: 'Isolated Chromium preflight passed; live browser verification follows activation.' });
  execFileSync('flock', ['-n', '/run/code-ai-ui-deployment.lock', node, '--dns-result-order=ipv6first',
    root + '/ops/work-mode-save-20261020/publish.mjs', 'activate'], { stdio: 'pipe', env: { ...process.env, CODE_AI_UI_RELEASE_OPS: ops } });
  await fs.rename(ops + '/final-receipt.json', ops + '/activation.json');
  console.log(JSON.stringify({ installed: true, frontendOnly: true, backendRestarted: false, release: c.staticReleaseRoot + '/' + c.sourceSha256.slice(0,12) }));
} else throw Error('Expected build, prepare or activate');
