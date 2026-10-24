import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: 'payload', stdio: 'inherit' });
const require = createRequire(path.resolve('payload/package.json'));
const { build } = require('esbuild');
const checks = [
  'server/codexUserInput.test.ts', 'server/codexAppServer.test.ts', 'server/codexFileAssets.test.ts',
  'server/codexSessionTransport.test.ts', 'server/codexSessionMessages.test.ts',
  'server/codexSessionFiles.test.ts', 'server/codexQueueStopPolicy.test.ts',
  'server/codexQueueWorkspaceList.test.ts', 'server/providerProcessLifecycle.test.ts',
  'client/src/components/codex/userInputQuestionCardState.test.ts',
  'client/src/components/codex/userInputTimeline.test.ts',
  'client/src/components/codex/htmlPreviewDocument.test.ts',
  'client/src/components/codex/timelinePresentation.test.ts',
  'client/src/components/codex/composerPrompt.test.ts', 'client/src/components/codex/activeTasks.test.ts',
  'client/src/components/codex/sessionTimelineSync.test.ts',
  'client/src/components/codex/sendPressGesture.test.ts',
  'client/src/components/codex/browserSelectionContext.test.ts',
  'client/src/sessionRoute.test.ts', 'shared/uploadLimits.test.ts',
];
await mkdir('payload/.qualification', { recursive: true });
const outputs = [];
for (const file of checks) {
  const outfile = path.resolve('payload/.qualification', file.replace(/\//g, '-').replace(/\.ts$/, '.mjs'));
  await build({ absWorkingDir: path.resolve('payload'), entryPoints: [file], outfile,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22', logLevel: 'warning' });
  outputs.push(outfile);
}
execFileSync(process.execPath, ['--test', ...outputs], { cwd: 'payload', stdio: 'inherit', timeout: 120_000 });
const ui = [];
for (const file of ['client/src/components/codex/markdownFiles.test.ts', 'client/src/components/codex/MarkdownFileImage.test.tsx']) {
  const outfile = path.resolve('payload/.qualification', path.basename(file).replace(/\.tsx?$/, '.cjs'));
  await build({ absWorkingDir: path.resolve('payload'), entryPoints: [file], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' });
  ui.push(outfile);
}
execFileSync(process.execPath, ['--test', ...ui], { cwd: 'payload', stdio: 'inherit', timeout: 60_000 });
