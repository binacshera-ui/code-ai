import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = '/root/projects/code-ai';
const accepted = '/mnt/hdd/code-ai-builds/drafts-panel-imports/74ee3eaf-de92-4f53-be0b-c0a1e46fa1be/artifact/dist';
const stage = await mkdtemp('/mnt/hdd/code-ai-builds/pci-runtime-source-');
for (const file of ['package.json','pnpm-lock.yaml','test.mjs','build.mjs','smoke.mjs','package-contract.mjs']) await cp(path.join(root,'ops/pci-code-ai-runtime',file),path.join(stage,file));
await mkdir(path.join(stage,'payload'),{recursive:true});
await cp(accepted,path.join(stage,'payload/prebuilt'),{recursive:true});
for(const file of ['package.json','package-lock.json']) await cp(path.join(root,file),path.join(stage,'payload',file));
for(const relative of ['server/browser-mode','server/design-mode','server/personal-chrome','server/ux-mode','server/phone-mode','skills/gemini-design-partner','skills/gemini-ux-partner','skills/code-ai-conversation-search']) {
  await mkdir(path.dirname(path.join(stage,'payload',relative)),{recursive:true});
  await cp(path.join(root,relative),path.join(stage,'payload',relative),{recursive:true});
}
await cp('/root/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl',path.join(stage,'payload/codex-vendor'),{recursive:true});
const files = {};
for(const file of ['payload/prebuilt/server.js','payload/codex-vendor/bin/codex','payload/package.json','payload/package-lock.json']) files[file]=createHash('sha256').update(await readFile(path.join(stage,file))).digest('hex');
await writeFile(path.join(stage,'input-manifest.json'),JSON.stringify({sourceServerBuildId:'74ee3eaf-de92-4f53-be0b-c0a1e46fa1be',files},null,2)+'\n');
console.log(JSON.stringify({stage,sourceServerBuildId:'74ee3eaf-de92-4f53-be0b-c0a1e46fa1be',files: Object.keys(files)}));
