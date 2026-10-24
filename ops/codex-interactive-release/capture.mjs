import { cp, mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = '/root/projects/code-ai';
const baseline = '/mnt/hdd/code-ai-builds/drafts-panel-corrected-YkVl4c/payload';
const stage = await mkdtemp('/mnt/hdd/code-ai-builds/codex-interactive-source-');
await chmod(stage, 0o700);
for (const name of ['package.json','pnpm-lock.yaml','test.mjs','build.mjs','fake-codex.mjs','api-smoke.mjs']) {
  await cp(path.join(root, 'ops/codex-interactive-release', name), path.join(stage, name));
}
await mkdir(stage + '/payload');
for (const name of ['client','server','shared','scripts','skills','chrome-extension','package.json','package-lock.json','tsconfig.json','vite.config.ts']) {
  await cp(path.join(baseline,name), path.join(stage,'payload',name), {recursive:true,verbatimSymlinks:true});
}
const files = [
  'server/codexService.ts', 'server/codexRoutes.ts', 'server/remoteHostProxy.ts',
  'server/codexFileAssets.ts', 'server/codexFileAssets.test.ts',
  'server/codexAppServer.ts', 'server/codexAppServer.test.ts',
  'server/codexUserInput.ts', 'server/codexUserInput.test.ts', 'shared/codexUserInput.ts',
  'client/src/components/codex/CodexMobileApp.tsx',
  'client/src/components/codex/MarkdownFileImage.tsx', 'client/src/components/codex/MarkdownFileImage.test.tsx',
  'client/src/components/codex/markdownFiles.ts', 'client/src/components/codex/markdownFiles.test.ts',
  'client/src/components/codex/HtmlFilePreview.tsx', 'client/src/components/codex/UserInputQuestionCard.tsx',
  'client/src/components/codex/htmlPreviewDocument.ts', 'client/src/components/codex/htmlPreviewDocument.test.ts',
  'client/src/components/codex/userInputQuestionCardState.ts', 'client/src/components/codex/userInputQuestionCardState.test.ts',
  'client/src/components/codex/useCodexUserInput.ts',
  'client/src/components/codex/userInputTimeline.ts', 'client/src/components/codex/userInputTimeline.test.ts',
];
for (const file of files) await cp(path.join(root,file), path.join(stage,'payload',file));
// codexService also contains an unrelated, not-yet-activated history restoration
// change in the worktree. Preserve it there, but release only this native-run slice
// onto the attested active baseline rather than silently installing that change.
const servicePath = 'server/codexService.ts';
const nativeService = await readFile(path.join(root,servicePath), 'utf8');
let candidateService = await readFile(path.join(baseline,servicePath), 'utf8');
const runSliceStart = 'export function cancelCodexRun(runId: string): boolean {';
const baselineSliceAt = candidateService.indexOf(runSliceStart);
const nativeSliceAt = nativeService.indexOf(runSliceStart);
assert.ok(baselineSliceAt > 0 && nativeSliceAt > 0, 'Native run boundary is absent');
assert.ok(nativeService.slice(nativeSliceAt).includes('runCodexAppServerTurn({'), 'Native integration is absent');
const runSlice = nativeService.slice(nativeSliceAt)
  .replace('    if (previousSession) requireOriginalSessionRecord(previousSession);\n', '');
candidateService = candidateService.slice(0,baselineSliceAt) + runSlice;
const modelImport = "import { isUserSelectableCodexModel } from './codexModelVisibility.js';";
assert.ok(candidateService.includes(modelImport), 'Native import insertion boundary is absent');
candidateService = candidateService.replace(modelImport,
  modelImport + "\nimport { runCodexAppServerTurn, CodexAppServerCancelledError } from './codexAppServer.js';");
const activeInterface = 'interface ActiveCodexRun {\n  child: ReturnType<typeof spawn>;\n  cancelRequested: boolean;\n}';
assert.ok(candidateService.includes(activeInterface), 'Native active-run interface boundary is absent');
candidateService = candidateService.replace(activeInterface,
  'interface ActiveCodexRun {\n  child: ReturnType<typeof spawn>;\n  cancelRequested: boolean;\n  interrupt?: () => void;\n}');
assert.equal(candidateService.includes('codexStoredHistory.mjs'), false, 'Unrelated history work leaked into candidate');
await writeFile(path.join(stage,'payload',servicePath), candidateService);
// Pin the already-locked browser CSS parser without importing unrelated package
// scripts or dependency edits from this dirty shared worktree.
const packagePath = path.join(stage, 'payload', 'package.json');
const lockPath = path.join(stage, 'payload', 'package-lock.json');
const candidatePackage = JSON.parse(await readFile(packagePath, 'utf8'));
const candidateLock = JSON.parse(await readFile(lockPath, 'utf8'));
assert.equal(candidateLock.packages['node_modules/postcss'].version, '8.5.6');
candidatePackage.devDependencies.postcss = '8.5.6';
candidateLock.packages[''].devDependencies.postcss = '8.5.6';
await writeFile(packagePath, JSON.stringify(candidatePackage, null, 2) + '\n');
await writeFile(lockPath, JSON.stringify(candidateLock, null, 2) + '\n');
files.push('package.json', 'package-lock.json');
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const activeHash = await hash(root+'/dist/server.js');
assert.equal(activeHash,'240e9f7e6a5b14a8e0754134cb1b448e051e6580bab0ddafb751bf9a381b07c7', 'Accepted runtime changed; recapture onto its successor');
const identity = { baselineBuildId:'74ee3eaf-de92-4f53-be0b-c0a1e46fa1be', activeHash,
  serviceOverlay: 'native run slice only; unrelated history restoration remains uninstalled',
  qualificationHashes: Object.fromEntries(await Promise.all(['package.json','pnpm-lock.yaml','test.mjs','build.mjs','fake-codex.mjs','api-smoke.mjs']
    .map(async file => [file, await hash(path.join(stage,file))]))),
  changedPaths: files, sourceHashes: Object.fromEntries(await Promise.all(files.map(async file => [file,await hash(path.join(stage,'payload',file))]))) };
await writeFile(stage+'/source-identity.json', JSON.stringify(identity,null,2)+'\n', {mode:0o600});
console.log(JSON.stringify({stage,baselineBuildId:identity.baselineBuildId,changedPaths:files.length}));
