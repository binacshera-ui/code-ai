import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root='/root/projects/code-ai',scratch='/mnt/hdd/code-ai-builds/github-publish-20261024-v547I40v';
const source=scratch+'/source';await fs.mkdir(source,{recursive:true});
const names=[...new Set(execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))];
const files=[];
for(const name of names){
 const metadata=await fs.lstat(root+'/'+name).catch(()=>null);if(!metadata)continue;
 if(metadata.isSymbolicLink()&&name.startsWith('ops/'))continue;
 assert.ok(metadata.isFile(),'Unexpected symlink or special source file: '+name);
 assert.ok(!name.startsWith('.code-ai/')&&!name.startsWith('node_modules/')&&!name.endsWith('.log'));
 await fs.mkdir(path.dirname(source+'/'+name),{recursive:true});await fs.copyFile(root+'/'+name,source+'/'+name);
 files.push({name,sha256:createHash('sha256').update(await fs.readFile(source+'/'+name)).digest('hex'),size:metadata.size});
}
await fs.writeFile(scratch+'/source-files.json',JSON.stringify({root,source,files},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({files:files.length,bytes:files.reduce((sum,row)=>sum+row.size,0),source}));
