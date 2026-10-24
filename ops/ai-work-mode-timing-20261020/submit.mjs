import fs from'node:fs/promises';import{spawn}from'node:child_process';
const ops='/root/projects/code-ai/ops/ai-work-mode-timing-20261020',c=JSON.parse(await fs.readFile(ops+'/capture.json','utf8')),prefix=ops+'/build-'+c.sourceSha256.slice(0,12);
await fs.writeFile(ops+'/build-current.json',JSON.stringify({sourceSha256:c.sourceSha256,acceptedFile:prefix+'-accepted.json',resultFile:prefix+'-result.json'}),{mode:0o600});
const child=spawn('/usr/local/bin/bina-build',['build','--profile','node-package-v1','--project','code-ai','--component','modes-timing','--source-dir',c.source,'--expected-peak-gib','3','--import-root','/mnt/hdd/code-ai-builds/ai-work-mode-timing-import-20261020','--requested-by','code-ai-session-01a05cd0','--client-key',c.sourceSha256,'--accepted-file',prefix+'-accepted.json','--result-file',prefix+'-result.json'],{stdio:'inherit'});
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
