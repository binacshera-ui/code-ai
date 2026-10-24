import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.resolve('payload/package.json'));
const { build } = require('esbuild');
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['payload/scripts/codex-shared-stdio.mjs'], outfile: 'dist/codex-shared-stdio.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
  banner: { js: 'import { createRequire as bridgeCreateRequire } from "node:module"; const require = bridgeCreateRequire(import.meta.url);' } });
await cp('manifest.json', 'dist/manifest.json');
await cp('payload/server/codexAppServer.ts', 'dist/codexAppServer.ts');
console.log(JSON.stringify({ qualifiedTransportOnly: true, installedEffects: false, fullApplicationRelease: false }));
