import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {execFileSync}from'node:child_process';
const prepared=JSON.parse(await fs.readFile('ops/focus-notifications-20261020/beam-10g-prepare.json','utf8'));
const script=`
import fs from'node:fs/promises';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';
const candidate=${JSON.stringify(prepared.candidate)},baseline=${JSON.stringify(prepared.baseline)},service='code-ai-remote-beam-10g.service';
const req=JSON.parse(await fs.readFile(candidate+'/fleet-request.json','utf8'));
const{releaseOverrideName}=await import(candidate+'/release-order.mjs');
const ctl=(...args)=>execFileSync('systemctl',args,{encoding:'utf8'}).trim();
assert.equal(ctl('show',service,'-p','WorkingDirectory','--value'),candidate);
const file=ctl('show',service,'-p','FragmentPath','--value')+'.d/'+releaseOverrideName(req);
const queue='/var/lib/code-ai-remote/beam-10g/queue/state.json';
const before=await fs.readFile(queue);await fs.writeFile(candidate+'/private-deployment-backup/post-acceptance-rollback-queue.json',before,{mode:0o600,flag:'wx'});
await fs.rename(file,file+'.withdrawn-after-acceptance-failure');ctl('daemon-reload');
assert.equal(ctl('show',service,'-p','WorkingDirectory','--value'),baseline);
ctl('stop',service);ctl('start',service);assert.equal(ctl('is-active',service),'active');
const after=JSON.parse(await fs.readFile(queue,'utf8')),ids=new Set(after.items.map(i=>i.id));
assert.ok(JSON.parse(before).items.every(i=>ids.has(i.id)));
const{parseEnv}=await import('node:util');const token=parseEnv(await fs.readFile(req.environmentFile,'utf8')).CODEX_REMOTE_AGENT_TOKEN;
let health;for(let i=0;i<40;i++){try{const r=await fetch('http://127.0.0.1:4010/api/codex/remote-agent/health',{headers:{'x-code-ai-remote-token':token},signal:AbortSignal.timeout(2000)});if(r.ok){health=await r.json();if(health.ok)break;}}catch{}await new Promise(r=>setTimeout(r,500));}
assert.equal(health?.ok,true);assert.equal(health.version,baseline.split('/').at(-1));
const result={id:'beam-10g',rolledBack:true,activeRelease:baseline,version:health.version,ready:health.ready,queueRecordsPreserved:true,withdrawnCandidatePreserved:true,nativeOwnersRestarted:false,reason:'Second-profile native thread/start timed out during release acceptance',finishedAt:new Date().toISOString()};
await fs.writeFile(candidate+'/post-acceptance-rollback.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
`;
execFileSync(process.execPath,['--input-type=module','--check'],{input:script});
const result=JSON.parse(execFileSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','beam-10g','sudo -n /opt/node-v24.18.0-linux-x64/bin/node --input-type=module -'],{input:script,encoding:'utf8',timeout:90000}));
assert.equal(result.rolledBack,true);await fs.writeFile('ops/focus-notifications-20261020/beam-10g-rollback.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
