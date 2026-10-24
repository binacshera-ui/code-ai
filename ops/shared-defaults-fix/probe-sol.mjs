import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {liveApi} from './live-api.mjs';
const {env}=await liveApi();
const bin=process.argv[2] || '/root/.nvm/versions/node/v24.12.0/bin/codex';
if(!['/usr/bin/codex','/root/.nvm/versions/node/v24.12.0/bin/codex'].includes(bin))throw Error('Unexpected CLI path');
const child=spawn(bin,['exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only','-C','/tmp','--model','gpt-6.1-sol','-c','model_reasoning_effort="low"','--json','Respond with exactly SOL_6_1_OK. Do not use any tools or read any files.'],{env:{...env,CODEX_HOME:'/home/developer/.codex'},stdio:['ignore','pipe','pipe']});
let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
child.on('close',async code=>{
 clearTimeout(timer);const events=out.split('\n').filter(Boolean).flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}});
 const result={observedAt:new Date().toISOString(),bin,model:'gpt-6.1-sol',exitCode:code,events:events.filter(x=>['error','turn.failed','turn.completed'].includes(x.type)),response:events.filter(x=>x.item?.type==='agent_message').map(x=>x.item.text),stderrTail:err.slice(-1800)};
 await writeFile('/root/projects/code-ai/ops/shared-defaults-fix/'+(bin==='/usr/bin/codex'?'system-cli-sol-inference.json':'sol-inference.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=code||0;
});
