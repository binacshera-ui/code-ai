import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_FILES, MAX_UPLOAD_BATCH_BYTES, planUploadBatches } from './uploadLimits.js';

test('limits are five times the previous 15 MiB / 8 files', () => {
  assert.equal(MAX_UPLOAD_FILE_BYTES, 5 * 15 * 1024 * 1024);
  assert.equal(MAX_UPLOAD_FILES, 5 * 8);
});

test('40 maximum-size files are split below the proxy limit, preserving order', () => {
  const files = Array.from({ length: 40 }, (_, i) => ({ name: `${i}.zip`, size: MAX_UPLOAD_FILE_BYTES }));
  const batches = planUploadBatches(files);
  assert.equal(batches.length, 40);
  assert.deepEqual(batches.flat(), files);
  assert.ok(batches.every((batch) => batch.reduce((sum, file) => sum + file.size, 0) <= MAX_UPLOAD_BATCH_BYTES));
});

test('small files, unknown extensions, empty MIME types and zero-byte files are allowed', () => {
  const files = Array.from({ length: 40 }, (_, i) => ({ name: `${i}.custom`, size: i, type: '' }));
  assert.deepEqual(planUploadBatches(files), [files]);
  assert.deepEqual(planUploadBatches([]), []);
});

test('mixed-size batches stay within the byte budget without duplicating files', () => {
  const files = [50, 25, 1, 74, 0].map((mib, i) => ({ name: `${i}.7z`, size: mib * 1024 * 1024 }));
  const batches = planUploadBatches(files);
  assert.deepEqual(batches.map((batch) => batch.length), [2, 3]);
  assert.deepEqual(batches.flat(), files);
});

test('invalid selections are rejected before creating any batches', () => {
  assert.throws(() => planUploadBatches([{ name: 'big.zip', size: MAX_UPLOAD_FILE_BYTES + 1 }]), /75MB/);
  assert.throws(() => planUploadBatches(Array.from({ length: 41 }, () => ({ name: 'a', size: 0 }))), /40/);
  for (const size of [-1, NaN, Infinity, 0.5]) {
    assert.throws(() => planUploadBatches([{ name: 'invalid', size }]));
  }
});
