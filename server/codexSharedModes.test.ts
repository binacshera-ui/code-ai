import assert from'node:assert/strict';import test from'node:test';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';
test('full shared mode bridge initializes every shipped catalog without depending on configured app root',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-mode-package-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=root+'/.codex';await fs.mkdir(home,{mode:0o700});process.env.CODEX_APP_ROOT=root+'/historical-unavailable';process.env.CODEX_STORAGE_ROOT=root+'/state';
 const {ensureCodexSharedModeBridge}=await import('./codexSharedModes.js');
 const bridge=await ensureCodexSharedModeBridge({id:'isolated',codexHome:home,workspaceCwd:root,label:'Isolated',provider:'codex',mode:'normal'} as any,{uid:process.getuid!(),gid:process.getgid!()});
 try{assert.equal(Object.keys(bridge.mcpConfigurations).length,5);for(const[name,config]of Object.entries(bridge.mcpConfigurations)){assert.ok(config.args.includes(name));assert.ok(config.args[0].endsWith('codex-shared-modes/mcp.mjs'));assert.match(bridge.catalogIdentities[name as keyof typeof bridge.catalogIdentities],/^[a-f0-9]{64}$/);}}
 finally{await bridge.close();}
});
