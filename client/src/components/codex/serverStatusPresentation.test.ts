import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerStatusSnapshot } from '../../../../shared/serverStatus';
import {
  appendServerStatusHistory, formatServerBytes, formatServerPercent, formatServerRate, formatServerUptime,
  groupServerVolumes, primaryServerNetwork, serverTrendGeometry, serverStatusWarningLabel, startServerStatusPolling,
} from './serverStatusPresentation';

const sample = (time = 0) => ({ version: 1, hostname: 'main', sampledAt: new Date(time).toISOString() }) as ServerStatusSnapshot;
const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
class Visibility {
  hidden = false;
  listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'visibilitychange', listener: () => void) { this.listeners.delete(listener); }
  set(hidden: boolean) { this.hidden = hidden; for (const listener of this.listeners) listener(); }
}

test('byte, percent and rate labels distinguish unknown samples from actual zero', () => {
  assert.equal(formatServerBytes(0), '0 B');
  assert.equal(formatServerBytes(1024 ** 4 * 2.5), '2.5 TiB');
  assert.equal(formatServerBytes(null), 'לא זמין');
  assert.equal(formatServerBytes(-1), 'לא זמין');
  assert.equal(formatServerPercent(0), '0.0%');
  assert.equal(formatServerPercent(null), 'ממתין לדגימה');
  assert.equal(formatServerPercent(1000), '100.0%');
  assert.equal(formatServerRate(null), 'ממתין לדגימה');
  assert.equal(formatServerRate(1024), '1 KiB/s');
  assert.equal(formatServerUptime(90061), '1 ימים ו־1 שעות');
});

test('fixed warning codes become readable partial-data labels without exposing unknown raw errors', () => {
  assert.match(serverStatusWarningLabel('cpu_warming_up'), /שתי דגימות/);
  assert.match(serverStatusWarningLabel('network_partial'), /מממשקי הרשת/);
  assert.match(serverStatusWarningLabel('storage_stale'), /הקריאה האחרונה/);
  assert.match(serverStatusWarningLabel('memory_unavailable'), /הזיכרון/);
  assert.equal(serverStatusWarningLabel('<img onerror=bad>'), 'חלק מנתוני השרת אינם זמינים למדידה.');
});

test('history stores only real advancing sample timestamps and is bounded to 60', () => {
  let history: ServerStatusSnapshot[] = [];
  for (let index = 0; index < 70; index++) history = appendServerStatusHistory(history, sample(index * 2000));
  assert.equal(history.length, 60);
  assert.equal(history[0].sampledAt, sample(20_000).sampledAt);
  assert.equal(appendServerStatusHistory(history, sample(0)), history);
  assert.equal(appendServerStatusHistory(history, sample(138_000)), history);
  assert.equal(appendServerStatusHistory(history, { ...sample(), sampledAt: 'bad' }), history);
});

test('trends do not invent data before a first sample, across unknown samples or across hidden gaps', () => {
  assert.deepEqual(serverTrendGeometry([]), { paths: [], dots: [], count: 0 });
  const one = serverTrendGeometry([{ at: 100, value: 20 }], 100);
  assert.equal(one.paths.length, 0);
  assert.equal(one.dots.length, 1);
  const sparse = serverTrendGeometry([{ at: 100, value: 20 }, { at: 2100, value: null }, { at: 4100, value: 40 }, { at: 30_000, value: 0 }], 100);
  assert.equal(sparse.paths.length, 0);
  assert.equal(sparse.dots.length, 3);
  assert.equal(sparse.count, 3);
  assert.match(serverTrendGeometry([{ at: 100, value: 0 }, { at: 2100, value: 100 }], 100).paths[0], /^M2\.0,56\.0 L318\.0,4\.0$/);
});

test('storage capacities aggregate within actual media classes only and network is not summed', () => {
  const volumes = [
    { medium: 'nvme', totalBytes: 100, usedBytes: 60, availableBytes: 35, reservedBytes: 5 },
    { medium: 'hdd', totalBytes: 900, usedBytes: 300, availableBytes: 600, reservedBytes: 0 },
    { medium: 'other', totalBytes: 50, usedBytes: 10, availableBytes: 40, reservedBytes: 0 },
  ] as NonNullable<ServerStatusSnapshot['storage']>['volumes'];
  const groups = groupServerVolumes(volumes);
  assert.equal(groups.find(group => group.medium === 'nvme')?.totalBytes, 100);
  assert.equal(groups.find(group => group.medium === 'hdd')?.availableBytes, 600);
  assert.equal(groups.find(group => group.medium === 'ssd')?.volumes.length, 0);
  const network = [{ name: 'first', isDefault: false, state: 'up' }, { name: 'main', isDefault: true, state: 'up' }] as NonNullable<ServerStatusSnapshot['network']>;
  assert.equal(primaryServerNetwork(network)?.name, 'main');
  assert.equal(primaryServerNetwork(null), null);
});

test('manual retries never overlap an in-flight request and cleanup aborts exactly that request', async t => {
  const visibility = new Visibility();
  const pending: Array<(value: ServerStatusSnapshot) => void> = [];
  const signals: AbortSignal[] = [];
  const seen: ServerStatusSnapshot[] = [];
  const controller = startServerStatusPolling({ visibility, intervalMs: 1000, timeoutMs: 1000,
    load: signal => { signals.push(signal); return new Promise(resolve => pending.push(resolve)); },
    onSnapshot: snapshot => seen.push(snapshot), onError: error => assert.fail(error), onPending: () => {},
  });
  t.after(() => controller.stop());
  controller.refresh(); controller.refresh();
  assert.equal(signals.length, 1);
  pending[0](sample(2000));
  await delay(5);
  assert.equal(seen.length, 1);
  assert.equal(signals.length, 2);
  controller.stop();
  assert.equal(signals[1].aborted, true);
  assert.equal(visibility.listeners.size, 0);
  pending[1](sample(4000));
  await delay();
  assert.equal(seen.length, 1);
});

test('hidden pages abort and suppress stale results, then immediately resume with one request', async t => {
  const visibility = new Visibility();
  const requests: Array<{ signal: AbortSignal; resolve: (value: ServerStatusSnapshot) => void }> = [];
  const seen: ServerStatusSnapshot[] = [];
  const controller = startServerStatusPolling({ visibility, intervalMs: 1000, timeoutMs: 1000,
    load: signal => new Promise(resolve => requests.push({ signal, resolve })),
    onSnapshot: snapshot => seen.push(snapshot), onError: error => assert.fail(error), onPending: () => {},
  });
  t.after(() => controller.stop());
  visibility.set(true);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(sample(2000));
  await delay();
  assert.equal(seen.length, 0);
  assert.equal(requests.length, 1);
  visibility.set(false);
  assert.equal(requests.length, 2);
  requests[1].resolve(sample(4000));
  await delay();
  assert.equal(seen.length, 1);
});

test('polling does not start on hidden mount and timeout becomes a visible retryable error', async t => {
  const visibility = new Visibility();
  visibility.hidden = true;
  const errors: Error[] = [];
  let requests = 0;
  const controller = startServerStatusPolling({ visibility, intervalMs: 1000, timeoutMs: 5,
    load: signal => { requests++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); },
    onSnapshot: () => assert.fail('timeout must not become a sample'), onError: error => errors.push(error), onPending: () => {},
  });
  t.after(() => controller.stop());
  assert.equal(requests, 0);
  visibility.set(false);
  await delay(12);
  assert.equal(requests, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /לא השיב/);
});
