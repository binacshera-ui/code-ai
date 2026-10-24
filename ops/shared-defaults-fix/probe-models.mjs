import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {liveApi} from './live-api.mjs';
const {env}=await liveApi();
const paths=[env.CODEX_BIN||'/root/.nvm/versions/node/v24.12.0/bin/codex','/usr/bin/codex'];
const results=[];
for(const bin of [...new Set(paths)]) {
 const version=execFileSync(bin,['--version'],{env,encoding:'utf8'}).trim();
 const data=JSON.parse(execFileSync(bin,['debug','models'],{env:{...env,CODEX_HOME:'/home/developer/.codex'},encoding:'utf8',timeout:60000,maxBuffer:12*1024*1024}));
 results.push({bin,version,models:(data.models||[]).map(m=>({slug:m.slug,displayName:m.display_name,visibility:m.visibility,efforts:m.supported_reasoning_levels?.map(x=>x.effort)}))});
}
await writeFile('/root/projects/code-ai/ops/shared-defaults-fix/cli-models.json',JSON.stringify({observedAt:new Date().toISOString(),results},null,2));
console.log(JSON.stringify(results));
