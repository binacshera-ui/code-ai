import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const backend = ['server/serverStatus.test.ts', 'server/serverStatusRoutes.test.ts'];
const frontend = ['serverStatusTransport.test.ts', 'serverStatusPresentation.test.ts', 'ServerStatusDialog.test.tsx']
  .map(name => 'client/src/components/codex/' + name);
if (process.argv[2] === 'backend') {
  await build({ entryPoints: backend, bundle: true, platform: 'node', format: 'esm', packages: 'external', outdir: 'qualification/tests' });
  execFileSync(process.execPath, ['--test', ...backend.map(name => 'qualification/tests/' + path.basename(name).replace(/\.ts$/, '.js'))], { stdio: 'inherit' });
  await build({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/app.mjs',
    external: ['express', 'multer', 'cors', 'express-session', 'connect-pg-simple', 'pg', 'node-pty', 'ws'] });
} else if (process.argv[2] === 'ui') {
  await build({ entryPoints: frontend, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', outdir: 'qualification/tests' });
  execFileSync(process.execPath, ['--test', ...frontend.map(name => 'qualification/tests/' + path.basename(name).replace(/\.tsx?$/, '.js'))], { stdio: 'inherit' });
  const require = createRequire(import.meta.url);
  execFileSync(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'], { stdio: 'inherit' });
} else throw Error('Expected backend or ui');
