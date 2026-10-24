#!/usr/bin/env node
import net from 'node:net';import fs from 'node:fs';import {spawn} from 'node:child_process';
import {relayArguments} from './ubuntu-contract.mjs';

try {
 const config=JSON.parse(fs.readFileSync('/var/lib/code-ai-ubuntu-gpu-lab/relay.json','utf8'));
 if(config.targetAlias!=='personal-ubuntu-ssh'||config.ubuntuUsername!=='refael'||config.ubuntuComputerName!=='gpu-lab'
  ||!Number.isSafeInteger(config.port)||config.port===44022||config.port<1024||config.port>65535)throw new Error('INVALID_UBUNTU_TARGET');
 const args=relayArguments(process.env.SSH_ORIGINAL_COMMAND||'');
 const available=await new Promise(resolve=>{
  const socket=net.createConnection({host:'127.0.0.1',port:config.port});let done=false;
  const finish=result=>{if(done)return;done=true;socket.destroy();resolve(result);};
  socket.setTimeout(1200);socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
 });
 if(!available){process.stderr.write('Ubuntu reverse SSH is awaiting local activation; no remote command ran.\n');process.exitCode=69;}
 else{
  const child=spawn('/usr/bin/ssh',args,{stdio:'inherit',shell:false,env:{PATH:'/usr/bin:/bin',HOME:'/root',LANG:'C.UTF-8'}});
  child.once('error',()=>{process.stderr.write('Unable to start Ubuntu relay.\n');process.exitCode=70;});
  child.once('exit',(code,signal)=>{process.exitCode=code??(signal?128:70);});
  process.once('SIGTERM',()=>child.kill('SIGTERM'));process.once('SIGINT',()=>child.kill('SIGINT'));
 }
}catch{process.stderr.write('Ubuntu relay command or target is not allowlisted.\n');process.exitCode=64;}
