import { cp,mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';

const root='/root/projects/code-ai';
const baseline='/mnt/hdd/code-ai-builds/drafts-panel-corrected-YkVl4c/payload';
const mainPath='client/src/components/codex/CodexMobileApp.tsx';
const expectedServer='240e9f7e6a5b14a8e0754134cb1b448e051e6580bab0ddafb751bf9a381b07c7';
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
assert.equal(await hash(root+'/dist/server.js'),expectedServer,'Accepted runtime moved; integrate onto its successor first');
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/chrome-profile-edit-source-');
for(const name of ['package.json','pnpm-lock.yaml','test.mjs','build.mjs'])await cp(path.join(root,'ops/chrome-profile-edit-release',name),path.join(stage,name));
await mkdir(stage+'/payload');
for(const name of ['client','server','shared','scripts','skills','chrome-extension','package.json','package-lock.json','tsconfig.json','vite.config.ts']) {
  await cp(path.join(baseline,name),path.join(stage,'payload',name),{recursive:true,verbatimSymlinks:true});
}
const files=[
  'chrome-extension/README.md','chrome-extension/background.js','chrome-extension/manifest.json',
  'chrome-extension/panel.css','chrome-extension/panel.html','chrome-extension/panel.js',
  'chrome-extension/bridgeTransport.js','chrome-extension/profileIdentity.js','chrome-extension/profileIdentity.d.ts',
  'chrome-extension/profileSync.js','chrome-extension/profileSync.d.ts','chrome-extension/panelOpen.js',
  'chrome-extension/panelPairing.js','chrome-extension/selectionAccess.js',
  'server/personalChromeBridge.ts','server/personalChromeProtocol.ts',
  'client/src/components/codex/PersonalChromeModeDialog.tsx','client/src/components/codex/PersonalChromeProfileEditor.tsx',
  'client/src/components/codex/personalChromeProfile.ts',
  'scripts/personal-chrome-extension.test.mjs','scripts/personal-chrome-background-startup.test.mjs',
  'scripts/personal-chrome-device-contract.test.mjs','scripts/personal-chrome-panel-profile.test.mjs',
  'scripts/personal-chrome-panel-pairing.test.mjs','scripts/personal-chrome-transport.test.mjs',
  'scripts/personal-chrome-profile-sync.test.mjs','scripts/personal-chrome-bridge-e2e.mjs',
];
for(const file of files)await cp(path.join(root,file),path.join(stage,'payload',file));

// Never copy the dirty root application: unrelated native-question/Markdown work is not part of this release.
let main=await readFile(path.join(baseline,mainPath),'utf8');
const edited=await readFile(path.join(root,mainPath),'utf8');
const replaceOnce=(before,after)=>{
  assert.equal(main.split(before).length,2,'Integration anchor must occur exactly once');
  main=main.replace(before,after);
};
const importAnchor="} from './PersonalChromeModeDialog';";
replaceOnce(importAnchor,importAnchor+"\nimport { ChromeProfileConflictError, mergeChromeProfiles, saveChromeProfile } from './personalChromeProfile';\nimport type { ChromeProfileIdentity } from '../../../../chrome-extension/profileIdentity.js';");
const start='  async function loadPersonalChromeDevices() {';
const end='  async function createPersonalChromePairingCode() {';
assert.equal(main.split(start).length,2);assert.equal(main.split(end).length,2);
assert.equal(edited.split(start).length,2);assert.equal(edited.split(end).length,2);
const oldBlock=main.slice(main.indexOf(start),main.indexOf(end));
const newBlock=edited.slice(edited.indexOf(start),edited.indexOf(end));
assert.ok(newBlock.includes('savePersonalChromeDeviceProfile'));assert.ok(newBlock.includes('mergeChromeProfiles'));
replaceOnce(oldBlock,newBlock);
const oldChip="<span className=\"truncate\">Chrome אישי · {sessionPersonalChromeMode.deviceName || 'מכשיר מזווג'} · {getPersonalChromeApprovalPolicyLabel(sessionPersonalChromeMode.approvalPolicy)}</span>";
const newChip="<span className=\"truncate\">תוסף Chrome · {personalChromeDevices.find(device => device.id === sessionPersonalChromeMode.deviceId)?.name || sessionPersonalChromeMode.deviceName || 'מכשיר מזווג'} · {getPersonalChromeApprovalPolicyLabel(sessionPersonalChromeMode.approvalPolicy)}</span>";
assert.ok(edited.includes(newChip));replaceOnce(oldChip,newChip);
const saveAnchor='        onRevokeDevice={(deviceId) => void revokePersonalChromeDeviceFromDialog(deviceId)}';
replaceOnce(saveAnchor,saveAnchor+'\n        onSaveProfile={savePersonalChromeDeviceProfile}');
await writeFile(path.join(stage,'payload',mainPath),main);
files.push(mainPath);
assert.equal(JSON.parse(await readFile(stage+'/payload/chrome-extension/manifest.json','utf8')).version,'1.5.2');
assert.equal(await hash(root+'/dist/server.js'),expectedServer,'Runtime changed during capture');
const metadata={project:'code-ai',component:'chrome-profile-edit',capturedAt:new Date().toISOString(),
  baselineBuildId:'74ee3eaf-de92-4f53-be0b-c0a1e46fa1be',baselineServerSha256:expectedServer,
  predecessorProfileBuildId:'23711fe1-41fa-49b7-aac7-9c63ef7c3a6b',retention:'prepared-not-active',
  changedPaths:files,mainApplicationIntegration:'Four explicit Chrome-profile hunks only',
  sourceHashes:Object.fromEntries(await Promise.all(files.map(async file=>[file,await hash(path.join(stage,'payload',file))])))};
await writeFile(stage+'/source-identity.json',JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify({stage,baselineBuildId:metadata.baselineBuildId,changedPathCount:files.length}));
