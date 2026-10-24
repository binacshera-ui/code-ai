import fs from'node:fs/promises';import{spawn}from'node:child_process';
const root='/root/projects/code-ai/ops/work-modes-routing-20261020';
const capture=JSON.parse(await fs.readFile(root+'/capture.json','utf8'));
const prefix=root+'/build-'+capture.sourceSha256.slice(0,12);
await fs.mkdir('/mnt/hdd/code-ai-builds/work-modes-routing-import-20261020',{recursive:true});
await fs.writeFile(root+'/build-current.json',JSON.stringify({source:capture.source,sourceSha256:capture.sourceSha256,acceptedFile:prefix+'-accepted.json',resultFile:prefix+'-result.json'}),{mode:0o600});
const child=spawn('/usr/local/bin/bina-build',['build','--profile','node-package-v1','--project','code-ai',
 '--component','work-modes-routing','--source-dir',capture.source,'--expected-peak-gib','3',
 '--import-root','/mnt/hdd/code-ai-builds/work-modes-routing-import-20261020',
 '--requested-by','code-ai-session-01a05cd0','--client-key',capture.sourceSha256,'--accepted-file',prefix+'-accepted.json','--result-file',prefix+'-result.json'],{stdio:'inherit'});
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
