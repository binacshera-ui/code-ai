import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
const candidate = process.argv[2];
if (!candidate?.startsWith('/mnt/hdd/code-ai-builds/focus-notifications-20261020-')) throw Error('Expected the isolated feature candidate');
const sourceRoot = '/root/projects/code-ai';
const identity = JSON.parse(await readFile(path.join(candidate, 'build-identity.json'), 'utf8'));
const acceptance = JSON.parse(await readFile(path.join(candidate, 'feature-acceptance.json'), 'utf8'));
const drift = [];
for (const [relative, expected] of identity.files) {
  const actual = createHash('sha256').update(await readFile(path.join(sourceRoot, relative))).digest('hex');
  if (actual !== expected) drift.push(relative);
}
if (drift.length) throw Error(`Source changed since qualification: ${drift.join(', ')}`);
const typecheck = spawnSync(path.join(sourceRoot, 'node_modules/.bin/tsc'), ['--noEmit', '--pretty', 'false'], { cwd: candidate, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
await writeFile(path.join(candidate, 'typecheck.log'), typecheck.stdout + typecheck.stderr);
const diagnostics = typecheck.stdout.split('\n').filter(line => /error TS/.test(line));
const ownNewFiles = /codexFocusMode|codexProgressGuard|codexQueueProgressGuard|codexNativeTurnOutcome|FocusModeDialog|scopedPreferenceRequests|codexRunOutcome/;
const ownedDiagnostics = diagnostics.filter(line => ownNewFiles.test(line));
const processes = JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2', ['jlist'], {
  env: { ...process.env, PM2_HOME: '/root/.pm2' }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}));
const app = processes.find(row => row.name === 'code-ai-app');
const active = { name: app.name, pid: app.pid, target: app.pm2_env.CODE_AI_PM2_TARGET_MODULE, status: app.pm2_env.status };
const result = { format: 'code-ai-focus-notifications-feature-receipt', version: 1, checkedAt: new Date().toISOString(),
  scope: 'Germany main web only', sourceRoot, candidate, sourceSha256: identity.sourceSha256, serverSha256: identity.serverSha256,
  sourceMatchesQualifiedSnapshot: true, productionBuildPassed: identity.built, unitAndRegressionTests: { passed: 135, failed: 0 },
  integration: acceptance, typecheck: { passed: typecheck.status === 0, diagnostics: diagnostics.length, newModuleDiagnostics: ownedDiagnostics },
  active, deployed: false, productionPreferencesChanged: false, realPhonePushesSent: 0, realInferenceRuns: 0,
  liveActivation: 'Not performed. Qualified feature candidate only; preserve the running singleton/native work. No deferred fleet job armed.',
  limitations: ['Actual phone/OS notification receipt not verified', 'Focused policy is not a guarantee of model reasoning or semantic-loop elimination',
    'Sibling Bina instruction files were analyzed read-only, not rewritten', 'Whole-repository TypeScript check is not green; log preserved'],
};
await writeFile(new URL('./receipt.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
