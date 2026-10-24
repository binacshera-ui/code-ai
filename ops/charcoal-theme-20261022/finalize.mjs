import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const ops = '/root/projects/code-ai/ops/charcoal-theme-20261022';
const json = async name => JSON.parse(await fs.readFile(ops + '/' + name + '.json', 'utf8'));
const activation = await json('activation'), preview = await json('preview-browser'), live = await json('live-browser'), chrome = await json('personal-chrome');
assert.ok(activation.installed && preview.passed && live.passed && chrome.passed);
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'), activation.release + '/locations.conf');
const processes = JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2', ['jlist'], {encoding:'utf8', env:{...process.env, PM2_HOME:'/root/.pm2'}}));
assert.equal(processes.find(p => p.name === 'code-ai-app').pid, activation.applicationPidBefore);
for (const pid of [1614273,1614274]) process.kill(pid, 0);
const receipt = {...activation, finishedAt:new Date().toISOString(),
  product:'Code-AI neutral charcoal dark theme, Bina Cshera 3.0 palette',
  verification:{unitTestsPassed:7, scopedTypeScriptPassed:true, productionWebBuildPassed:true,
    previewBrowser:preview, liveBrowser:live, personalChrome:chrome},
  browserVerification:'Preview and public live Chromium passed, plus delivered CSS verified in personal Chrome without style injection.',
  lightPresetsUnchanged:true, userPreferencesUnchanged:true,
  nativeOwnerPidsUnchanged:[1614273,1614274], remoteCommandsExecuted:false,
  storage:'Isolated source, build and static release on HDD; prior assets and rollback release retained',
  limitations:['TypeScript verification scoped to changed terminal component, not the unrelated dirty repository.',
    'Theme offers existing light/dark controls only; no new system-theme control was added.']};
await fs.writeFile(ops + '/final-receipt.json', JSON.stringify(receipt,null,2)+'\n', {mode:0o600});
console.log(JSON.stringify({installed:true, release:activation.release, allScopedChecksPassed:true, backendRestarted:false, nativeOwnersRestarted:false}));
