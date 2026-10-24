import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuestionResponse, verifyServedAssets, recoverMainTransaction } from './transaction-contract.mjs';

for (const status of [200, 400, 401, 403, 404]) test('question JSON accepts contractual status ' + status, () => {
  verifyQuestionResponse(new Response('{}', { status, headers: { 'content-type': 'application/json' } }));
});
for (const status of [200, 403]) test('question rejects SPA HTML at ' + status, () => {
  assert.throws(() => verifyQuestionResponse(new Response('<html/>', { status, headers: { 'content-type': 'text/html' } })));
});
test('question refuses server failure', () => {
  assert.throws(() => verifyQuestionResponse(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })));
});
const server = bytes => async url => new Response(url.endsWith('/')
  ? '<script src="/assets/index-fixture.js"></script>' : bytes, { status: 200 });
test('candidate assets verified against candidate files', async () => {
  const paths = [];
  await verifyServedAssets({ origin: 'http://fixture', releaseRoot: '/candidate', fetch: server('candidate-bytes'),
    readFile: async path => { paths.push(path); return Buffer.from('candidate-bytes'); } });
  assert.deepEqual(paths, ['/candidate/dist/public/assets/index-fixture.js']);
});
test('rollback assets verified against predecessor, not candidate', async () => {
  const paths = [];
  await verifyServedAssets({ origin: 'http://fixture', releaseRoot: '/predecessor', fetch: server('old-bytes'),
    readFile: async path => { paths.push(path); assert.match(path, /^\/predecessor\//); return Buffer.from('old-bytes'); } });
  assert.deepEqual(paths, ['/predecessor/dist/public/assets/index-fixture.js']);
});
test('mismatched served release is refused', async () => {
  await assert.rejects(verifyServedAssets({ origin: 'http://fixture', releaseRoot: '/candidate', fetch: server('old-bytes'),
    readFile: async () => Buffer.from('candidate-bytes') }));
});
function fixture(failures = {}) {
  const calls = [];
  const actions = Object.fromEntries(['restorePointer', 'restoreUploadOverride', 'restartMain', 'checkMainBaseline',
    'savePm2', 'restartUploads', 'checkUploads'].map(name => [name, async () => {
    calls.push(name);
    if (failures[name]) throw Object.assign(new Error('PRIVATE_DIAGNOSTIC_MUST_NOT_BE_RETURNED'), { code: failures[name] });
  }]));
  return { calls, actions };
}
test('full rollback restores and verifies both services', async () => {
  const f = fixture();
  const result = await recoverMainTransaction({ swapped: true, override: true, stopped: true, actions: f.actions });
  assert.equal(result.verified, true);
  assert.deepEqual(f.calls, ['restorePointer', 'restoreUploadOverride', 'restartMain', 'checkMainBaseline', 'savePm2', 'restartUploads', 'checkUploads']);
});
test('failed main readiness still restores uploads and preserves error metadata only', async () => {
  const f = fixture({ checkMainBaseline: 'ENOENT' });
  const result = await recoverMainTransaction({ swapped: true, override: true, stopped: true, actions: f.actions });
  assert.equal(result.uploadReadinessVerified, true);
  assert.equal(result.verified, false);
  assert.deepEqual(result.errors, [{ step: 'mainReadinessVerified', code: 'ENOENT' }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_DIAGNOSTIC'), false);
});
test('failed main restart does not prevent uploads recovery', async () => {
  const f = fixture({ restartMain: 'EIO' });
  const result = await recoverMainTransaction({ swapped: true, override: true, stopped: true, actions: f.actions });
  assert.equal(result.uploadReadinessVerified, true);
  assert.equal(f.calls.includes('checkMainBaseline'), false);
});
test('pointer restoration failure refuses main restart but recovers uploads', async () => {
  const f = fixture({ restorePointer: 'EACCES' });
  const result = await recoverMainTransaction({ swapped: true, override: true, stopped: true, actions: f.actions });
  assert.equal(f.calls.includes('restartMain'), false);
  assert.equal(result.uploadReadinessVerified, true);
});
test('upload configuration restoration failure refuses upload restart but recovers main', async () => {
  const f = fixture({ restoreUploadOverride: 'EIO' });
  const result = await recoverMainTransaction({ swapped: true, override: true, stopped: true, actions: f.actions });
  assert.equal(result.mainReadinessVerified, true);
  assert.equal(f.calls.includes('restartUploads'), false);
});
test('pre-stop failure causes no service restart', async () => {
  const f = fixture();
  await recoverMainTransaction({ swapped: false, override: true, stopped: false, actions: f.actions });
  assert.deepEqual(f.calls, ['restoreUploadOverride']);
});
