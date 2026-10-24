import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the copy imports the original CODE-AI app and stylesheet', async () => {
  const [html, entry, vite] = await Promise.all(['index.html', 'preview-main.tsx', 'vite.config.ts'].map((name) => readFile(path.join(root, name), 'utf8')));
  assert.match(html, /preview-main\.tsx/);
  assert.match(entry, /import\('@original\/App'\)/);
  assert.match(entry, /@original\/index\.css/);
  assert.doesNotMatch(entry, /serviceWorker/);
  assert.match(vite, /Original CODE-AI client source is required/);
});

test('all requests are intercepted locally and writes are blocked', async () => {
  const api = await readFile(path.join(root, 'previewApi.ts'), 'utf8');
  assert.match(api, /window\.fetch = previewFetch/);
  assert.match(api, /method !== 'GET'/);
  assert.match(api, /url\.origin !== window\.location\.origin/);
  assert.match(api, /403/);
  assert.doesNotMatch(api, /originalFetch|nativeFetch|\.bind\(window\)/);
});
