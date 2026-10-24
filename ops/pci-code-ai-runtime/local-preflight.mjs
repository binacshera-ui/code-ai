import { mkdtemp, mkdir, cp, symlink } from 'node:fs/promises';
import { smoke } from './smoke.mjs';
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/pci-offline-contract-');
await cp('/mnt/hdd/code-ai-builds/drafts-panel-imports/74ee3eaf-de92-4f53-be0b-c0a1e46fa1be/artifact/dist',stage+'/dist',{recursive:true});
await symlink('/root/projects/code-ai/node_modules',stage+'/node_modules');
await mkdir(stage+'/server');
for(const name of ['personal-chrome','browser-mode','design-mode','ux-mode','phone-mode'])await cp('/root/projects/code-ai/server/'+name,stage+'/server/'+name,{recursive:true});
await cp('/root/projects/code-ai/skills',stage+'/skills',{recursive:true});
console.log(JSON.stringify(await smoke({appRoot:stage,codexBin:'/root/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'})));
