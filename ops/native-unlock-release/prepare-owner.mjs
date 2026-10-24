/** Additive qualified native owner installation. No credentials or old writers touched. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, realpath, chown, chmod, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { renderUserUnit, validateProfilePlan, renderDesktopOverride } from '../native-owner/profile-artifacts.mjs';
const [requestFile] = process.argv.slice(2);
const request = JSON.parse(await readFile(requestFile,'utf8'));
assert.equal(request.ownerAuthorizedInterruption,true);
const digest = b=>createHash('sha256').update(b).digest('hex');
const root=request.candidate;
const controller=request.ownerControllerDirectory||root;
const planVersion=request.ownerControllerBuildId||request.buildId;
assert.match(planVersion,/^[a-f0-9-]{36}$/);
if(request.ownerControllerBuildId){
  assert.match(request.ownerControllerManifestSha256,/^[a-f0-9]{64}$/);
  const bytes=await readFile(controller+'/release-files.json');
  assert.equal(digest(bytes),request.ownerControllerManifestSha256,'Controller identity changed');
  const manifest=JSON.parse(bytes);
  for(const [file,sha] of Object.entries(manifest.files)){
    assert.ok(!path.isAbsolute(file)&&!file.split('/').includes('..'));
    assert.equal(digest(await readFile(controller+'/'+file)),sha,'Controller file changed');
  }
  const q=JSON.parse(await readFile(controller+'/qualification/runner.json','utf8'));
  assert.equal(q.installedEffects,false);assert.equal(q.actualNativeLifecycleQualified,true);
  assert.equal(q.sourceSha256['ops/native-owner/profile-runner.mjs'],manifest.files['ops/native-owner/profile-runner.mjs']);
}
const run=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',timeout:30000}).trim();
const uid=request.ownerUid,gid=request.ownerGid;
assert.ok(Number.isInteger(uid)&&uid>=0&&Number.isInteger(gid)&&gid>=0);
const user=request.id==='ubuntu-gpu-lab';
const ctl=args=>run('/usr/bin/systemctl',[...(user?['--user']:[]),...args]);
async function privateDir(dir) {
  const previous=await lstat(dir).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(previous) assert.ok(previous.isDirectory()&&!previous.isSymbolicLink()&&previous.uid===uid&&(previous.mode&0o077)===0,'Existing private directory policy mismatch');
  else {await mkdir(dir,{mode:0o700});await chown(dir,uid,gid);}
}
async function privateFile(file,content) {
  const old=await lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(old){assert.ok(old.isFile()&&!old.isSymbolicLink()&&old.uid===uid&&(old.mode&0o077)===0);assert.equal(await readFile(file,'utf8'),content,'Owned artifact identity changed');return;}
  await writeFile(file,content,{mode:0o600,flag:'wx'});await chown(file,uid,gid);
}
const receipts=[];
for(const p of request.ownerProfiles) {
  assert.equal(p.nativeBinarySha256,digest(await readFile(p.nativeBinary)));
  assert.ok(['0.162.1','0.162.0-alpha.2'].includes(p.nativeVersion),'Native version not qualified');
  const home=await realpath(p.codexHome), parent=path.join(home,'code-ai-shared-owner'), directory=path.join(p.userHome,'code-ai-native-owner');
  await privateDir(parent);await privateDir(directory);
  // Add missing mode skills only. Existing user skills/symlinks are never replaced.
  const previousSkills=await lstat(home+'/skills').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!previousSkills){await mkdir(home+'/skills',{mode:0o755});await chown(home+'/skills',uid,gid);}
  for(const skill of ['gemini-design-partner','gemini-ux-partner','reapre-phone-control']) {
    const destination=home+'/skills/'+skill;
    const old=await lstat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!old) await symlink(root+'/skills/'+skill,destination);
  }
  const dispatcherRoot=root+'/server/codex-shared-modes';
  const mcpDispatchers=[];
  for(const [serverName,program,interpreter] of [
    ['personal_chrome','personal-chrome/personal_chrome_mcp_server.mjs',request.nodeExecutable],
    ['browser_mode','browser-mode/python/browser_mode_mcp_server.py','/usr/bin/python3'],
    ['phone_mode','phone-mode/phone_mode_mcp_server.mjs',request.nodeExecutable],
    ['design_mode','design-mode/design_mode_mcp_server.mjs',request.nodeExecutable],
    ['ux_mode','ux-mode/ux_mode_mcp_server.mjs',request.nodeExecutable]]) {
    const data=run(interpreter,[root+'/server/'+program,'--describe-tools']);
    const catalog=JSON.parse(data);assert.ok(Array.isArray(catalog.tools)&&catalog.tools.length>0);
    const catalogPath=parent+'/'+serverName+'-tools.json';
    await privateFile(catalogPath,JSON.stringify(catalog)+'\n');
    mcpDispatchers.push({serverName,command:request.nodeExecutable,
      args:[dispatcherRoot+'/mcp.mjs','--server',serverName,'--socket',parent+'/modes.sock','--catalog',catalogPath],
      required:false,startup_timeout_sec:20,tool_timeout_sec:360});
  }
  const plan=validateProfilePlan({format:'code-ai-native-owner-profile',version:1,profileId:p.id,
    userHome:p.userHome,codexHome:home,ownerDirectory:directory,nativeBinary:p.nativeBinary,nativeBinarySha256:p.nativeBinarySha256,
    nodeBinary:request.nodeExecutable,brokerModule:root+'/server/codexSharedOwnerBroker.mjs',brokerModuleSha256:digest(await readFile(root+'/server/codexSharedOwnerBroker.mjs')),
    dispatcherModule:root+'/scripts/codex-shared-cli.mjs',adapterModule:root+'/scripts/codex-shared-stdio.mjs',
    runnerModule:controller+'/ops/native-owner/profile-runner.mjs',guiLauncherModule:root+'/ops/native-owner/gui-launcher.mjs',
    frontendSocket:parent+'/owner.sock',desktopExecutable:p.desktopExecutable||'/usr/bin/false',mcpDispatchers,
    guiBooleanRequirements:{'features.code_mode_host':true,
      'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled':true,
      'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled':true}});
  const planPath=directory+'/profile-'+planVersion+'.json';await privateFile(planPath,JSON.stringify(plan,null,2)+'\n');
  let unit=renderUserUnit(plan,planPath);
  if(!user) unit=unit.replace('After=default.target','After=network.target').replace('WantedBy=default.target','WantedBy=multi-user.target')
    .replace('[Service]\n','[Service]\nUser='+request.ownerUsername+'\nGroup='+request.ownerGroup+'\n');
  const unitName='code-ai-native-owner-'+p.id+'.service';
  const unitRoot=user?p.userHome+'/.config/systemd/user':'/etc/systemd/system';
  await mkdir(unitRoot,{recursive:true});
  const unitFile=unitRoot+'/'+unitName;
  const existingUnit=await readFile(unitFile,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(existingUnit!==null&&existingUnit!==unit){
    assert.equal(request.previousPartialOwnerBuildId,request.buildId,'Unknown existing owner unit');
    const previousPlanPath=directory+'/profile-'+request.buildId+'.json';
    const previousPlan=validateProfilePlan(JSON.parse(await readFile(previousPlanPath,'utf8')));
    assert.equal(previousPlan.profileId,p.id);assert.equal(previousPlan.brokerModule,plan.brokerModule);
    let previousUnit=renderUserUnit(previousPlan,previousPlanPath);
    if(!user)previousUnit=previousUnit.replace('After=default.target','After=network.target').replace('WantedBy=default.target','WantedBy=multi-user.target')
      .replace('[Service]\n','[Service]\nUser='+request.ownerUsername+'\nGroup='+request.ownerGroup+'\n');
    assert.equal(existingUnit,previousUnit,'Existing unit is not our failed preparation');
    assert.ok(['inactive','failed'].includes(ctl(['show',unitName,'-p','ActiveState','--value'])));
    const metadata=await lstat(unitFile);assert.ok(metadata.isFile()&&!metadata.isSymbolicLink());
    await privateFile(directory+'/unit-before-controller-'+planVersion,previousUnit);
    await writeFile(unitFile,unit,{mode:0o644});
  }else if(existingUnit===null)await writeFile(unitFile,unit,{mode:0o644,flag:'wx'});
  await chmod(plan.dispatcherModule,0o755);
  ctl(['daemon-reload']);ctl(['enable','--now',unitName]);
  assert.equal(ctl(['is-active',unitName]),'active');
  let ready;
  const deadline=Date.now()+45000;
  while(Date.now()<deadline) {try {ready=JSON.parse(await readFile(directory+'/ready.json','utf8'));if(ready.profileVerified===true)break;}catch{} await new Promise(r=>setTimeout(r,200));}
  assert.ok(ready?.profileVerified===true&&ready.brokerModuleSha256===plan.brokerModuleSha256,'Native readiness not proved');
  const probe=JSON.parse(run(request.nodeExecutable,[root+'/ops/native-owner/probe.mjs',home,String(uid),'product']));
  assert.equal(probe.managedOwner,true);assert.equal(probe.homeMatched,true);
  let desktopOverride=false;
  if(p.desktopFile) {
    const original=await readFile(p.desktopFile,'utf8');
    const rendered=renderDesktopOverride(plan,planPath,original);
    const desktopRoot=p.userHome+'/.local/share/applications';await mkdir(desktopRoot,{recursive:true});
    const filename=desktopRoot+'/'+path.basename(p.desktopFile);
    const previous=await readFile(filename).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(previous) await privateFile(directory+'/desktop-before-'+request.buildId,previous);
    await writeFile(filename,rendered.content,{mode:0o644});desktopOverride=true;
  }
  receipts.push({profileId:p.id,unit:unitName,planPath,managedOwner:true,probe,desktopOverride,
    oldNativeCanonicalUntouched:true,unrelatedWritersUntouched:true});
}
await writeFile(root+'/owner-preparation-receipt-'+planVersion+'.json',JSON.stringify({format:'code-ai-native-owner-preparation',version:1,profiles:receipts,
  observedAt:new Date().toISOString(),credentialRotation:false,guiMigrationVerified:false},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({prepared:true,profiles:receipts.map(r=>({id:r.profileId,unit:r.unit,managedOwner:r.managedOwner})),guiMigrationVerified:false}));
