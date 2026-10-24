import assert from 'node:assert/strict';
import { readFile, readdir, cp, mkdir, chmod, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const predecessor = '/mnt/hdd/code-ai-builds/immediate-interrupting-release-Y2ukB8';
const controller = '/mnt/hdd/code-ai-builds/immediate-release-imports/1643b455-315e-4524-b53e-eaebf45b9f9c/artifact/dist';
const hash = x => createHash('sha256').update(x).digest('hex');
const stage = await mkdtemp('/mnt/hdd/code-ai-builds/native-unlock-source-'); await chmod(stage, 0o700);
await cp(predecessor, stage, {recursive:true, filter: p => !/\/(node_modules|\.git|\.qualification|dist)(\/|$)/.test(p)
  && !/\/beam-(accepted|result)\.json(?:[.]|$)/.test(p)});
const replace = (source, old, next) => { assert.equal(source.split(old).length, 2, 'Qualified integration anchor changed'); return source.replace(old, next); };
// Only our shared-owner hunks are taken from the dirty service. Unrelated history
// work remains in its owner's working tree, not silently mixed into this release.
let service = await readFile(stage+'/payload/server/codexService.ts','utf8');
const current = await readFile(root+'/server/codexService.ts','utf8');
service = replace(service, "import { registerCodexDeploymentDrainParticipant }", "import { resolveCodexSharedSocket } from './codexSharedSocket.mjs';\nimport { ensureCodexSharedModeBridge, bindCodexSharedModeContext } from './codexSharedModes.js';\nimport { registerCodexDeploymentDrainParticipant }");
const start = '      const useSharedOwner = sharedProfiles.has(profile.id);';
const end = '      if (activeCodexRuns.get(activeRunId)?.cancelRequested) throw new CodexRunCancelledError();';
const a = service.indexOf(start), b = service.indexOf(end,a), c = current.indexOf(start), d = current.indexOf(end,c);
assert.ok(a>=0 && b>a && c>=0 && d>c); service = service.slice(0,a)+current.slice(c,d)+service.slice(b);
await writeFile(stage+'/payload/server/codexService.ts',service);
const owned = ['server/codexAppServer.ts','server/codexAppServer.test.ts','server/codexQueue.ts',
  'server/codexSharedSocket.mjs','server/codexSharedSocket.test.mjs','server/codexSharedOwnerBroker.mjs',
  'server/codexSharedOwnerBroker.test.mjs','server/codexSharedModes.ts','server/codex-shared-modes',
  'server/codexPhoneMode.ts','server/codexDesignMode.ts','server/codexUxMode.ts','server/codexBrowserViewer.ts',
  'server/phone-mode','server/design-mode','server/ux-mode','server/personal-chrome','server/browser-mode',
  'scripts/codex-shared-cli.mjs','scripts/codex-shared-cli.test.mjs','scripts/codex-shared-stdio.mjs',
  'scripts/codex-shared-stdio.test.mjs','scripts/codex-native-submit-contract.mjs',
  'scripts/codex-native-launch-contract.mjs','scripts/codex-shared-mode-contract.mjs','ops/native-owner',
  'ops/native-unlock-release/prepare-owner.mjs'];
for(const f of owned) {await mkdir(path.dirname(stage+'/payload/'+f),{recursive:true}); await cp(root+'/'+f,stage+'/payload/'+f,{recursive:true});}
let index = await readFile(stage+'/payload/server/index.ts','utf8');
index = replace(index,"import { shutdownCodexUxModeBridge } from './codexUxMode.js';","import { shutdownCodexUxModeBridge } from './codexUxMode.js';\nimport { closeCodexSharedModeBridges } from './codexSharedModes.js';");
index = replace(index,'    shutdownCodexDesignModeBridge(),\n    shutdownCodexUxModeBridge(),',
  '    closeCodexSharedModeBridges().then(() => Promise.all([\n      shutdownCodexDesignModeBridge(),\n      shutdownCodexUxModeBridge(),\n    ])),');
await writeFile(stage+'/payload/server/index.ts',index);
for(const f of ['transaction-contract.mjs','transaction-contract.test.mjs','runtime-auth.mjs','runtime-auth.test.mjs']) await cp(controller+'/'+f,stage+'/'+f);
let install = await readFile(root+'/ops/immediate-release/install.mjs','utf8');
install = replace(install,'async function writeOverride(service, command, baselineModule, baselineSha, workingDirectory) {','async function writeOverride(service, command, baselineModule, baselineSha, workingDirectory, sharedProfiles = "") {');
install = replace(install,"    + 'Environment=\"CODE_AI_CODEX_SHARED_OWNER_PROFILES=\"\\n';","    + 'Environment=\"CODE_AI_CODEX_SHARED_OWNER_PROFILES=' + sharedProfiles + '\"\\n';");
install = replace(install,"      request.baseline + '/dist/server.js', request.expectedBaselineSha256, request.candidate);","      request.authenticationBaselineModule, request.authenticationBaselineSha256, request.candidate, request.sharedProfiles);");
install = replace(install,"CODE_AI_AUTH_BASELINE_MODULE: request.baseline + '/dist/server.js',","CODE_AI_AUTH_BASELINE_MODULE: request.authenticationBaselineModule,");
install = replace(install,"CODE_AI_AUTH_BASELINE_SHA256: request.expectedBaselineSha256, CODE_AI_CODEX_SHARED_OWNER_PROFILES: ''","CODE_AI_AUTH_BASELINE_SHA256: request.authenticationBaselineSha256, CODE_AI_CODEX_SHARED_OWNER_PROFILES: request.sharedProfiles");
install = replace(install,'      request.uploadBaselineModule, request.uploadBaselineSha256, \'/root/projects/code-ai\');','      request.uploadAuthenticationBaselineModule, request.uploadAuthenticationBaselineSha256, \'/root/projects/code-ai\');');
install = install.replaceAll('sharedOwnerEnabled: false','sharedOwnerEnabled: true');
install = replace(install,'async function verifyCandidate() {','async function verifyCandidate() {\n  assert.match(request.sharedProfiles, /^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/);\n  assert.match(request.authenticationBaselineSha256, /^[a-f0-9]{64}$/);\n  assert.equal(await digest(request.authenticationBaselineModule), request.authenticationBaselineSha256);');
await writeFile(stage+'/install.mjs',install);
await cp(root+'/ops/native-unlock-release/server-entry.mjs',stage+'/server-entry.mjs');
await cp(root+'/ops/native-unlock-release/build.mjs',stage+'/build.mjs');
let test = await readFile(stage+'/test.mjs','utf8');
test += '\nexecFileSync(process.execPath,["--test","transaction-contract.test.mjs"],{stdio:"inherit",timeout:60000});\n';
test += '\nexecFileSync(process.execPath,["--test","server/codexSharedSocket.test.mjs","server/codexSharedOwnerBroker.test.mjs","server/codex-shared-modes/transport.test.mjs","scripts/codex-shared-cli.test.mjs","ops/native-owner/profile-artifacts.test.mjs","ops/native-owner/profile-runner.test.mjs"],{cwd:"payload",stdio:"inherit",timeout:180000});\n';
await writeFile(stage+'/test.mjs',test);
const files = {};
async function inventory(dir,prefix='') {for(const e of await readdir(dir,{withFileTypes:true})) {const f=prefix+e.name; if(e.isDirectory()) await inventory(dir+'/'+e.name,f+'/'); else files[f]=hash(await readFile(dir+'/'+e.name));}}
await inventory(stage);
const identity={format:'code-ai-native-unlock-source',version:1,capturedAt:new Date().toISOString(),qualifiedPredecessor:'06247301-58b8-4ec4-82cc-2c96f0b22a4d',files,credentialRotation:false,installedEffects:false};
await writeFile(stage+'/native-source-identity.json',JSON.stringify(identity,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({stage,clientKey:hash(Buffer.from(JSON.stringify(identity))),sourceCaptured:true,installedEffects:false}));
