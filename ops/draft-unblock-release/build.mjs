import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await cp('runtime', 'dist/runtime', { recursive: true });
for (const file of ['manifest.json', 'test.mjs']) await cp(file, 'dist/' + file);
await cp('source', 'dist/source', { recursive: true });
console.log(JSON.stringify({ packaged: true, unrelatedRuntimeBytesPreserved: true }));
