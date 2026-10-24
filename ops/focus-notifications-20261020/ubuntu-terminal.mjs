import fs from 'node:fs/promises';
import {fleetClient} from './fleet-live.mjs';
const api=await fleetClient(),file='ops/focus-notifications-20261020/ubuntu-terminal.json';
let record=JSON.parse(await fs.readFile(file,'utf8').catch(()=>'{"cursor":0}'));
if(!record.id){const {terminal}=await api('ubuntu-gpu-lab','/terminal/sessions',{profileId:'ubuntu-refael',cwd:'/home/refael',columns:200,rows:40});record.id=terminal.id;}
if(process.argv[2])await api('ubuntu-gpu-lab','/terminal/sessions/'+record.id+'/input',{data:process.argv[2]+'\r'});
await new Promise(r=>setTimeout(r,1500));
const output=await api('ubuntu-gpu-lab','/terminal/sessions/'+record.id+'/output?cursor='+record.cursor);
record.cursor=output.cursor??output.nextCursor??record.cursor;
await fs.writeFile(file,JSON.stringify(record),{mode:0o600});
console.log(JSON.stringify(output));
