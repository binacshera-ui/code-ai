import fs from'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{createRequire}from'node:module';
const project='/root/projects/code-ai',ops=project+'/ops/work-modes-ui-20261020';
const baseline=path.dirname(await fs.realpath(project+'/dist'));assert.equal(path.basename(baseline),'work-modes-routing-20261020-b06c11c03627');
const acceptedFrontend='/mnt/hdd/code-ai-builds/focus-notifications-20261020-usXxk3';
const changed=['CodexMobileApp.tsx','FocusModeDialog.tsx','WorkModeStatus.tsx','WorkModeCards.tsx','useSessionWorkModes.ts','workModePreferences.ts','workModeUi.test.tsx'].map(f=>'client/src/components/codex/'+f);
const source=await fs.mkdtemp('/mnt/hdd/code-ai-builds/work-modes-ui-source-20261020-');
for(const p of ['client','vite.config.ts','tsconfig.json','pnpm-lock.yaml','pnpm-workspace.yaml'])await fs.cp(acceptedFrontend+'/'+p,source+'/'+p,{recursive:true});
for(const p of ['shared','server','scripts','chrome-extension','package.json','package-lock.json'])await fs.cp(baseline+'/'+p,source+'/'+p,{recursive:true});
for(const p of changed)await fs.copyFile(project+'/'+p,source+'/'+p);
await fs.copyFile(ops+'/build.mjs',source+'/build-mode-ui.mjs');
const pkg=JSON.parse(await fs.readFile(source+'/package.json','utf8'));pkg.scripts={test:'node build-mode-ui.mjs test',build:'node build-mode-ui.mjs build'};await fs.writeFile(source+'/package.json',JSON.stringify(pkg,null,2)+'\n');
const ts=createRequire(project+'/package.json')('typescript'),seen=new Set(),missing=[];
async function resolve(file,spec){let base=spec.startsWith('@/')?source+'/client/src/'+spec.slice(2):path.resolve(path.dirname(file),spec);assert.ok(base.startsWith(source+'/'));
 for(const p of [base,...(/\.js$/.test(base)?[base.slice(0,-3)+'.ts',base.slice(0,-3)+'.tsx']:[]),...(!path.extname(base)?['.ts','.tsx','.js','.mjs','/index.ts','/index.tsx'].map(x=>base+x):[])])if(await fs.stat(p).then(s=>s.isFile()).catch(()=>false))return p;
 missing.push({file:path.relative(source,file),spec});}
async function visit(file){if(seen.has(file)||!/\.[cm]?[jt]sx?$/.test(file))return;seen.add(file);const s=ts.createSourceFile(file,await fs.readFile(file,'utf8'),ts.ScriptTarget.Latest,true);assert.equal(s.parseDiagnostics.length,0,'Syntax '+file);const specs=[];
 function walk(n){if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))specs.push(n.moduleSpecifier.text);if(ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword&&n.arguments.length===1&&ts.isStringLiteral(n.arguments[0]))specs.push(n.arguments[0].text);ts.forEachChild(n,walk);}walk(s);
 for(const spec of specs.filter(x=>x.startsWith('.')||x.startsWith('@/'))){const p=await resolve(file,spec);if(p)await visit(p);}}
await visit(source+'/client/src/main.tsx');await visit(source+'/client/src/components/codex/workModeUi.test.tsx');assert.deepEqual(missing,[],'Frontend graph is incomplete');
const files={};async function tree(rel=''){for(const e of(await fs.readdir(source+'/'+rel,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(rel,e.name);if(e.isDirectory())await tree(p);else{assert.ok(e.isFile());files[p]=createHash('sha256').update(await fs.readFile(source+'/'+p)).digest('hex');await fs.chmod(source+'/'+p,0o644);}}}await tree();
const sourceSha256=createHash('sha256').update(JSON.stringify(files)).digest('hex');
const result={source,sourceSha256,baseline,acceptedFrontend,changed,files,parsedFiles:seen.size,frontendOnly:true,createdAt:new Date().toISOString()};await fs.writeFile(ops+'/capture.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
await fs.mkdir('/mnt/hdd/code-ai-builds/work-modes-ui-import-20261020',{recursive:true});
console.log(JSON.stringify({source,sourceSha256,baseline,changed,parsedFiles:seen.size,files:Object.keys(files).length}));
