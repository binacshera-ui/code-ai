import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ServerStatusSnapshot } from '../../../../shared/serverStatus';
import { ServerStatusDialog, ServerStatusView } from './ServerStatusDialog';

const snapshot: ServerStatusSnapshot = {
  version: 1, hostname: 'example-server', platform: 'linux', sampledAt: '2026-10-21T12:00:00Z', sampleIntervalMs: 2000, uptimeSeconds: 3600,
  cpu: { model: 'Test CPU', logicalCores: 2, usedPercent: 25, freePercent: 75, cores: [30, 20], loadAverage: [1, 2, 3] },
  memory: { totalBytes: 1024 ** 3 * 64, usedBytes: 1024 ** 3 * 16, availableBytes: 1024 ** 3 * 48, freeBytes: 1024 ** 3 * 8, cacheBytes: 1024 ** 3 * 40, usedPercent: 25, swapTotalBytes: 1024 ** 3 * 2, swapUsedBytes: 0 },
  storage: { sampledAt: '2026-10-21T12:00:00Z', volumes: [{ device: '/dev/md2', mount: '/', filesystem: 'ext4', medium: 'nvme', totalBytes: 1024 ** 4 * 2, usedBytes: 1024 ** 4, availableBytes: 1024 ** 4 - 1024, reservedBytes: 1024, usedPercent: 50 }, { device: '/dev/md127', mount: '/mnt/data', filesystem: 'ext4', medium: 'hdd', totalBytes: 1024 ** 4 * 12, usedBytes: 1024 ** 4 * 7, availableBytes: 1024 ** 4 * 5, reservedBytes: 0, usedPercent: 7 / 12 * 100 }] },
  network: [{ name: 'enp4s0', isDefault: true, state: 'up', linkSpeedMbps: 1000, receivedBytes: 1024 ** 3, transmittedBytes: 1024 ** 2, receiveBytesPerSecond: 1024 ** 2, transmitBytesPerSecond: 1024 }], warnings: [],
};

test('real metrics expose separate media, CPU free, RAM available and measured network rate', () => {
  const html = renderToStaticMarkup(<ServerStatusView snapshot={snapshot} history={[snapshot]} />);
  for (const text of ['example-server', 'NVMe', 'HDD', 'SSD', 'אחר / לא מזוהה', '75.0%', '48 GiB', '1 MiB/s', '1,000 Mbps', '/mnt/data', '/dev/md127']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('ליבה 1') && html.includes('ליבה 2'));
  assert.ok(html.includes('לא בדיקת מהירות') && html.includes('ממשקים אינם נסכמים'));
  assert.ok(html.includes('לפני RAID') && html.includes('שמור למערכת'));
  assert.ok(html.includes('role="meter"') && html.includes('aria-valuenow="25"'));
  assert.ok(html.includes('dir="ltr"') && html.includes('1 דגימות אמיתיות'));
});

test('warmup samples never masquerade as zero CPU usage or zero bandwidth', () => {
  const initial = { ...snapshot, cpu: { ...snapshot.cpu!, usedPercent: null, freePercent: null, cores: [null, null] }, network: [{ ...snapshot.network![0], receiveBytesPerSecond: null, transmitBytesPerSecond: null, linkSpeedMbps: null }] };
  const html = renderToStaticMarkup(<ServerStatusView snapshot={initial} history={[initial]} />);
  assert.ok(html.includes('ממתין לדגימה') && html.includes('ממתין לדגימות קצב'));
  assert.ok(html.includes('לא זמינה'));
  assert.ok(!html.includes('0 B/s'));
  assert.ok(!html.includes('NaN') && !html.includes('Infinity'));
});

test('unsupported and partial hosts state unavailable without fabricated capacities', () => {
  const html = renderToStaticMarkup(<ServerStatusView snapshot={{ ...snapshot, cpu: null, memory: null, storage: null, network: null, warnings: ['storage_unavailable'] }} />);
  for (const text of ['נתוני המעבד אינם זמינים', 'נתוני הזיכרון אינם זמינים', 'נתוני האחסון אינם זמינים', 'נתוני ממשקי הרשת אינם זמינים']) assert.ok(html.includes(text));
  assert.ok(!html.includes('0 TiB') && !html.includes('0 GiB'));
  assert.ok(html.includes('מידע על הדגימה') && html.includes('נתוני האחסון אינם זמינים כרגע'));
});

test('host and warning text are rendered as text, never trusted markup', () => {
  const html = renderToStaticMarkup(<ServerStatusView snapshot={{ ...snapshot, hostname: '<script>bad</script>', warnings: ['<img src=x onerror=bad>'] }} />);
  assert.ok(html.includes('&lt;script&gt;') && html.includes('חלק מנתוני השרת אינם זמינים'));
  assert.ok(!html.includes('<script>') && !html.includes('<img src=x'));
});

test('dialog has accessible title/description/close/retry and begins empty, scoped to selected server', () => {
  const html = renderToStaticMarkup(<ServerStatusDialog serverId="local" serverLabel="השרת בגרמניה" loadStatus={async () => snapshot} onClose={() => {}} />);
  assert.ok(html.includes('role="dialog"') && html.includes('aria-label="מצב שרת · השרת בגרמניה"'));
  // Radix attaches aria-labelledby/aria-describedby after its title/description mount registration.
  assert.ok(html.includes('<h2') && html.includes('ניטור חי לקריאה בלבד'));
  assert.ok(html.includes('data-server-id="local"') && html.includes('השרת בגרמניה'));
  assert.ok(html.includes('סגור מצב שרת') && html.includes('רענן מצב שרת'));
  assert.ok(html.includes('ממתין למדידה אמיתית') && html.includes('לא מוצגים ערכי הדגמה'));
  assert.ok(!html.includes('example-server') && !html.includes('data-testid="server-status-metrics"'));
  assert.ok(html.includes('max-h-[94dvh]') && html.includes('min-h-0 overflow-y-auto'));
});
