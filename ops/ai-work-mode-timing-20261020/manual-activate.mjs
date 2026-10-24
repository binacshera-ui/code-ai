import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {spawn}from'node:child_process';
const project='/root/projects/code-ai',ops=project+'/ops/ai-work-mode-timing-20261020';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const c=await read(ops+'/capture.json'),b=await read(ops+'/manual-build.json'),p=await read(ops+'/prepared.json');
const statusFile=ops+'/manual-activation-status.json';
const status={buildId:b.buildId,sourceSha256:c.sourceSha256,startedAt:new Date().toISOString(),finished:false,events:[]};
const record=async(event,data={})=>{status.events.push({event,at:new Date().toISOString(),...data});await fs.writeFile(statusFile,JSON.stringify(status,null,2)+'\n',{mode:0o600});};
const node='/root/.nvm/versions/node/v24.12.0/bin/node';
async function command(name,args,env={}){
 await record(name+'.started');const log=await fs.open(ops+'/'+name+'.log','wx',0o600);
 const proc=spawn(args[0],args.slice(1),{cwd:project,env:{...process.env,...env},stdio:['ignore',log.fd,log.fd]});
 const code=await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('exit',resolve);});await log.close();
 await record(name+'.finished',{exitCode:code});assert.equal(code,0,name+' failed; see saved log');
}
try{
 assert.equal(b.passed,true);assert.equal(await fs.realpath(project+'/dist'),c.baseline+'/dist');
 assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),c.predecessorPointer);
 assert.equal((await read(ops+'/static-preflight.json')).passed,true);
 for(const id of['beam-10g','pci'])assert.equal((await read(ops+'/'+id+'-prepare.json')).expectedVersion,p.candidate.split('/').at(-1));
 for(const id of['beam-10g','pci'])await command(id+'-activate',[node,project+'/ops/work-modes-routing-20261020/fleet-prepare.mjs','activate',id],{CODE_AI_RELEASE_OPS:ops});
 await command('main-activate',[node,p.candidate+'/install.mjs','activate',p.candidate+'/fleet-request.json']);
 await command('live-save',[node,'--experimental-strip-types',project+'/ops/work-mode-save-20261020/live-save.mjs',c.source],{CODE_AI_UI_RELEASE_OPS:ops});
 await command('ui-activate',['flock','-n','/run/code-ai-ui-deployment.lock',node,project+'/ops/work-mode-save-20261020/publish.mjs','activate'],{CODE_AI_UI_RELEASE_OPS:ops});
 for(const id of['local','beam-10g','pci'])await command(id+'-native',[node,ops+'/native-accept.mjs',id]);
 const ui=await read(ops+'/final-receipt.json'),main=await read(p.candidate+'/activation-receipt.json');
 const remote=await Promise.all(['beam-10g','pci'].map(id=>read(ops+'/'+id+'-activation.json')));
 const native=await Promise.all(['local','beam-10g','pci'].map(id=>read(ops+'/'+id+'-native-acceptance.json')));
 assert.ok(ui.installed&&main.installed&&remote.every(x=>x.installed)&&native.every(x=>x.passed));
 status.finished=true;status.passed=true;status.finishedAt=new Date().toISOString();
 const receipt={format:'code-ai-model-owned-timing-manual-deployment',version:1,installed:true,buildId:b.buildId,sourceSha256:c.sourceSha256,
  buildType:b.buildType,authorization:b.authorization,release:p.candidate,targets:['main','beam-10g','pci'],
  finishedAt:status.finishedAt,buildChecks:b.checks,ui,main,remote,native,personalComputerChanged:false,ubuntuChanged:false,windowsChanged:false,
  nativeOwnerOrCodexBinaryReplaced:false,browserVerification:'No personal browser connected; component render, static HTTP and real native/API checks performed.'};
 await fs.writeFile(ops+'/deployment-receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 await fs.writeFile(ops+'/status.json',JSON.stringify({implemented:true,qualified:true,deployed:true,buildType:b.buildType,sourceSha256:c.sourceSha256,targets:receipt.targets,finishedAt:receipt.finishedAt},null,2)+'\n',{mode:0o600});
 await record('accepted');console.log(JSON.stringify({installed:true,targets:receipt.targets,sourceSha256:c.sourceSha256}));
}catch(error){status.finished=true;status.passed=false;status.error=error.message;await record('failed',{error:error.message});throw error;}
