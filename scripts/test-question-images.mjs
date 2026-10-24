#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.question-image-test-build');
const testFiles = [
  'server/codexAppServer.test.ts',
  'server/codexUserInput.test.ts',
  'server/codexFileAssets.test.ts',
  'client/src/components/codex/markdownFiles.test.ts',
  'client/src/components/codex/MarkdownFileImage.test.tsx',
  'client/src/components/codex/userInputQuestionCardState.test.ts',
  'client/src/components/codex/userInputTimeline.test.ts',
];
mkdirSync(output, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(path.join(root, 'node_modules', '.bin', 'esbuild'), [
  ...testFiles,
  '--bundle', '--platform=node', '--format=esm', '--packages=external',
  '--external:node-pty', '--outdir=' + output,
]);
run(process.execPath, [
  '--test',
  ...testFiles.map(file => path.join(output, file.replace(/\.tsx?$/, '.js'))),
]);
