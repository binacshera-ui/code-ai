#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {allowedCommand} from './code-ai-ubuntu-contract.mjs';
try {
 const command=allowedCommand(process.env.SSH_ORIGINAL_COMMAND||'');
 const child=spawn(command==='hostname'?'/usr/bin/hostname':'/usr/bin/id',command==='id -un'?['-un']:[],
  {stdio:'inherit',shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
 child.once('error',()=>{process.exitCode=70;});child.once('exit',code=>{process.exitCode=code??70;});
}catch{process.stderr.write('This Ubuntu key permits hostname, id and id -un checks only.\n');process.exitCode=64;}
