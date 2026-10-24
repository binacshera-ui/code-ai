import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {pathToFileURL}from'node:url';import path from'node:path';import os from'node:os';
import {codexRuntimePrograms,resolveCodexRuntimeProgram}from'./codexRuntimePrograms.mjs';
test('source and dist-only releases expose every canonical mode/auth/stdio program',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-programs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const layout of ['server','dist']){const d=root+'/'+layout;await fs.mkdir(d);for(const[name,relative]of Object.entries(codexRuntimePrograms)){const f=path.join(d,relative);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,'synthetic program');assert.equal(resolveCodexRuntimeProgram(name,{moduleUrl:pathToFileURL(d+'/app.mjs')}),f);}}
});
test('runtime release wins over stale configured root; unknown and missing programs fail closed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-selection-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const d of ['current/dist/codex-shared-modes','stale/server/codex-shared-modes']){await fs.mkdir(root+'/'+d,{recursive:true});await fs.writeFile(root+'/'+d+'/mcp.mjs','synthetic');}
 assert.equal(resolveCodexRuntimeProgram('sharedModes',{moduleUrl:pathToFileURL(root+'/current/dist/app.mjs'),sourceRoot:root+'/stale'}),root+'/current/dist/codex-shared-modes/mcp.mjs');
 assert.throws(()=>resolveCodexRuntimeProgram('../auth.json'),/UNKNOWN/);
 assert.throws(()=>resolveCodexRuntimeProgram('phone_mode',{moduleUrl:pathToFileURL(root+'/missing/app.mjs')}),/UNAVAILABLE/);
});
test('work-mode command belongs to active release, never stale APP_ROOT',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'work-mode-program-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const release of ['current','stale']){await fs.mkdir(root+'/'+release+'/scripts',{recursive:true});await fs.mkdir(root+'/'+release+'/dist');await fs.writeFile(root+'/'+release+'/scripts/codex-work-mode.mjs','synthetic');}
 assert.equal(resolveCodexRuntimeProgram('workMode',{moduleUrl:pathToFileURL(root+'/current/dist/app.mjs'),sourceRoot:root+'/stale'}),root+'/current/scripts/codex-work-mode.mjs');
});
