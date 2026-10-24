import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: 'payload', stdio: 'inherit' });
const require = createRequire(path.resolve('payload/package.json'));
const { build } = require('esbuild');
await mkdir('payload/.qualification', { recursive: true });
const outputs = [];
for (const file of ['server/codexAppServer.test.ts', 'server/codexUserInput.test.ts', 'server/providerProcessLifecycle.test.ts']) {
  const outfile = path.resolve('payload/.qualification', path.basename(file).replace(/\.ts$/, '.mjs'));
  await build({ absWorkingDir: path.resolve('payload'), entryPoints: [file], outfile,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22', logLevel: 'warning' });
  outputs.push(outfile);
}
execFileSync(process.execPath, ['--test', ...outputs, path.resolve('payload/scripts/codex-shared-stdio.test.mjs')],
  { cwd: 'payload', stdio: 'inherit', timeout: 90_000 });
