import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createCodexUploadMiddleware } from './codexUploads.js';
import { MAX_UPLOAD_FILE_BYTES } from '../shared/uploadLimits.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'code-ai-upload-test-'));
  const app = express();
  // Mirrors route ordering: authorization happens before accepting file bytes.
  app.post('/uploads', (req, res, next) => {
    if (req.headers['x-test-auth'] !== 'yes') return void res.sendStatus(401);
    next();
  }, createCodexUploadMiddleware(root), (req, res) => res.json({ files: req.files }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    root,
    post: (body: FormData, authorized = true) => fetch(`http://127.0.0.1:${address.port}/uploads`, {
      method: 'POST', headers: authorized ? { 'x-test-auth': 'yes' } : {}, body,
    }),
  };
}

test('accepts 40 arbitrary file types with correct bytes and Hebrew filenames', async (t) => {
  const { root, post } = await fixture(t);
  const body = new FormData();
  const bytes = new Uint8Array([0x50, 0x4b, 0, 1, 255]);
  for (let i = 0; i < 40; i++) body.append('files', new Blob([bytes]), `קובץ-${i}.${i % 2 ? 'zip' : 'custom'}`);
  const response = await post(body);
  assert.equal(response.status, 200);
  const { files } = await response.json() as any;
  assert.equal(files.length, 40);
  assert.equal(files[0].originalname, 'קובץ-0.custom');
  assert.equal((await readdir(root)).length, 40);
  assert.deepEqual(await readFile(files[0].path), Buffer.from(bytes));
});

test('accepts exactly 75 MiB and rejects one extra byte with JSON and cleanup', async (t) => {
  const { root, post } = await fixture(t);
  for (const size of [MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_FILE_BYTES + 1]) {
    const body = new FormData();
    body.append('files', new Blob([new Uint8Array(size)]), 'large.zip');
    const response = await post(body);
    const data = await response.json() as any;
    if (size === MAX_UPLOAD_FILE_BYTES) {
      assert.equal(response.status, 200);
      assert.equal(data.files[0].size, size);
      await rm(data.files[0].path);
    } else {
      assert.equal(response.status, 413);
      assert.equal(data.code, 'LIMIT_FILE_SIZE');
    }
    assert.deepEqual(await readdir(root), []);
  }
});

test('41 files are rejected and partial files removed', async (t) => {
  const { root, post } = await fixture(t);
  const body = new FormData();
  for (let i = 0; i < 41; i++) body.append('files', new Blob(['x']), `${i}.zip`);
  const response = await post(body);
  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).code, 'LIMIT_FILE_COUNT');
  assert.deepEqual(await readdir(root), []);
});

test('unauthorized requests never write uploads', async (t) => {
  const { root, post } = await fixture(t);
  const body = new FormData();
  body.append('files', new Blob(['private']), 'file.zip');
  assert.equal((await post(body, false)).status, 401);
  assert.deepEqual(await readdir(root), []);
});
