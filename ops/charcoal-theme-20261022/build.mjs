import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const require = createRequire(import.meta.url);
execFileSync(process.execPath, ['--test', 'client/src/themes/charcoal.test.mjs'], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'], { stdio: 'inherit' });
