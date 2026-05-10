#!/usr/bin/env node
import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '../..');

function printUsage() {
  console.log(`Usage: node deploy/code-ai/export-standalone.mjs [outputDir] [--git-init]

Arguments:
  outputDir   Optional target directory. Default: <app>/standalone-export/code-ai

Flags:
  --git-init  Initialize a git repository in the exported directory
  --help,-h   Show this help
`);
}

function parseArgs(argv) {
  let outputDir = path.join(APP_ROOT, 'standalone-export', 'code-ai');
  let gitInit = false;

  for (const arg of argv) {
    if (arg === '--git-init') {
      gitInit = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    outputDir = path.resolve(arg);
  }

  return { outputDir, gitInit };
}

async function copyRelativePath(outputDir, relativePath) {
  const sourcePath = path.join(APP_ROOT, relativePath);
  const targetPath = path.join(outputDir, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true });
}

async function writeRootWrapper(outputDir, filename, content, mode) {
  const targetPath = path.join(outputDir, filename);
  await writeFile(targetPath, content, 'utf8');
  if (typeof mode === 'number') {
    await chmod(targetPath, mode);
  }
}

async function removeExportNoise(rootPath) {
  if (!existsSync(rootPath)) {
    return;
  }

  const entries = await readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.name === '.mcp-backups') {
      await rm(entryPath, { recursive: true, force: true });
      continue;
    }

    if (entry.isDirectory()) {
      await removeExportNoise(entryPath);
      continue;
    }

    if (!entry.isSymbolicLink()) {
      continue;
    }

    const linkedStat = await stat(entryPath).catch(() => null);
    if (linkedStat?.isDirectory()) {
      await removeExportNoise(entryPath);
    }
  }
}

async function pruneStandaloneOnlyFiles(outputDir) {
  const pathsToRemove = [
    'client/src/components/dashboard',
    'client/src/pages',
    'client/src/stores/authStore.ts',
    'client/src/stores/chatStore.ts',
    'client/src/stores/logStore.ts',
    'client/src/lib/useSubmitGuard.ts',
    'server/dashboardRoutes.ts',
  ];

  for (const relativePath of pathsToRemove) {
    await rm(path.join(outputDir, relativePath), { recursive: true, force: true });
  }
}

async function main() {
  const { outputDir, gitInit } = parseArgs(process.argv.slice(2));

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const pathsToCopy = [
    'client',
    'server',
    'scripts',
    '.env.example',
    'AGENT.md',
    'AGENT.he.md',
    'WINDOWS.FIELD-NOTES.he.md',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.ts',
    'ecosystem.config.cjs',
    'deploy/code-ai',
  ];

  for (const relativePath of pathsToCopy) {
    await copyRelativePath(outputDir, relativePath);
  }

  await removeExportNoise(outputDir);
  await pruneStandaloneOnlyFiles(outputDir);

  await writeFile(path.join(outputDir, '.gitignore'), 'node_modules\ndist\n.env\n.code-ai\n', 'utf8');
  await cp(path.join(APP_ROOT, 'deploy/code-ai/README.md'), path.join(outputDir, 'README.md'));
  await cp(path.join(APP_ROOT, 'deploy/code-ai/README.he.md'), path.join(outputDir, 'README.he.md'));

  await writeRootWrapper(outputDir, 'install.sh', `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/deploy/code-ai/install.mjs" "$@"
`, 0o755);

  await writeRootWrapper(outputDir, 'export-standalone.sh', `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/deploy/code-ai/export-standalone.mjs" "$@"
`, 0o755);

  await writeRootWrapper(outputDir, 'install.cmd', `@echo off
set SCRIPT_DIR=%~dp0
node "%SCRIPT_DIR%deploy\\code-ai\\install.mjs" %*
exit /b %ERRORLEVEL%
`);

  await writeRootWrapper(outputDir, 'export-standalone.cmd', `@echo off
set SCRIPT_DIR=%~dp0
node "%SCRIPT_DIR%deploy\\code-ai\\export-standalone.mjs" %*
exit /b %ERRORLEVEL%
`);

  await writeRootWrapper(outputDir, 'install.ps1', `$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $ScriptDir 'deploy/code-ai/install.mjs') @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
`);

  await writeRootWrapper(outputDir, 'export-standalone.ps1', `$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $ScriptDir 'deploy/code-ai/export-standalone.mjs') @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
`);

  if (gitInit && existsSync(outputDir)) {
    spawnSync('git', ['init'], { cwd: outputDir, stdio: 'ignore' });
    spawnSync('git', ['add', '.'], { cwd: outputDir, stdio: 'ignore' });
    spawnSync('git', ['commit', '-m', 'Initial code-ai standalone export'], { cwd: outputDir, stdio: 'ignore' });
  }

  console.log(`Standalone export created at: ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
