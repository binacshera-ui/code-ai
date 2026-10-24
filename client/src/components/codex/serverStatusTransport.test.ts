import assert from 'node:assert/strict';
import test from 'node:test';
import { readServerStatus } from './serverStatusTransport';

const signal = new AbortController().signal;
test('old remote hosts and failed authentication never fall back to main-host data', async () => {
  for (const status of [404, 401, 403, 502, 503]) {
    let count = 0;
    await assert.rejects(readServerStatus(async supplied => {
      assert.equal(supplied, signal); count++;
      return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
    }, signal));
    assert.equal(count, 1);
  }
});
test('SPA fallthrough, invalid JSON and incompatible snapshots are not host metrics', async () => {
  for (const response of [new Response('<html/>'), new Response('not json', { headers: { 'content-type': 'application/json' } }),
    Response.json({ version: 2 }), Response.json({ version: 1, hostname: 'h', sampledAt: 'invalid' })]) {
    await assert.rejects(readServerStatus(async () => response, signal));
  }
});
test('real contract is returned intact, including null sections and partial warnings', async () => {
  const value = { version: 1, hostname: 'h', sampledAt: new Date().toISOString(), warnings: ['partial'], storage: null, cpu: null, memory: null, network: null };
  assert.deepEqual(await readServerStatus(async () => Response.json(value), signal), value);
});
test('request abort propagates without retry or switching hosts', async () => {
  const error = new DOMException('aborted', 'AbortError');
  await assert.rejects(readServerStatus(async () => { throw error; }, signal), e => e === error);
});
