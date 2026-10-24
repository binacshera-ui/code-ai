import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerStatusCollector, readLinuxBlockMetadata, type ServerStatusEngine } from './serverStatus.js';

function fixture(overrides: Partial<ServerStatusEngine> = {}) {
  let now = 0;
  let counters = { received: 1_000, transmitted: 2_000 };
  const calls: Record<string, number> = {};
  const methods: ServerStatusEngine = {
    cpu: async () => ({ brand: 'Test CPU', cores: 2 }),
    currentLoad: async () => ({ currentLoad: 25, cpus: [{ load: 20 }, { load: 30 }] }),
    mem: async () => ({ total: 1_000, available: 400, free: 100, cached: 200, buffers: 50, swaptotal: 100, swapused: 25 }),
    fsSize: async () => [{ fs: '/dev/md2', type: 'ext4', size: 1_000, used: 600, available: 350, mount: '/' }],
    blockDevices: async () => [{ name: 'nvme0n1p3', type: 'part', group: 'md2' }, { name: 'nvme0n1', type: 'disk', physical: 'SSD' }, { name: 'md2', type: 'raid1', mount: '/' }],
    networkInterfaces: async () => [{ iface: 'eth0', default: true, internal: false, virtual: false, operstate: 'up', speed: 1_000 }],
    networkStats: async () => [{ iface: 'eth0', operstate: 'up', rx_bytes: counters.received, tx_bytes: counters.transmitted }],
    ...overrides,
  };
  const engine = Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, (...args: unknown[]) => {
    calls[name] = (calls[name] || 0) + 1;
    return (method as (...args: unknown[]) => unknown)(...args);
  }])) as unknown as ServerStatusEngine;
  const collector = createServerStatusCollector({ engine, wallNow: () => Date.UTC(2026, 9, 21) + now,
    monotonicNow: () => now, timeoutMs: 20,
    host: { hostname: () => 'test-host', platform: () => 'linux', uptime: () => 42, loadAverage: () => [1, 2, 3] } });
  return { ...collector, calls, advance: (ms: number) => { now += ms; }, setCounters: (received: number, transmitted: number) => { counters = { received, transmitted }; } };
}

test('first CPU and network rates are pending, then fresh samples report real deltas', async () => {
  const subject = fixture();
  const first = await subject.getServerStatus();
  assert.equal(first.cpu?.usedPercent, null);
  assert.deepEqual(first.cpu?.cores, [null, null]);
  assert.equal(first.network?.[0].receiveBytesPerSecond, null);
  assert.ok(first.warnings.includes('cpu_warming_up'));
  assert.ok(first.warnings.includes('network_warming_up'));
  subject.advance(2_000); subject.setCounters(5_000, 3_000);
  const next = await subject.getServerStatus();
  assert.equal(next.cpu?.usedPercent, 25); assert.equal(next.cpu?.freePercent, 75);
  assert.deepEqual(next.cpu?.cores, [20, 30]);
  assert.equal(next.sampleIntervalMs, 2_000);
  assert.equal(next.network?.[0].receiveBytesPerSecond, 2_000);
  assert.equal(next.network?.[0].transmitBytesPerSecond, 500);
  assert.equal(next.network?.[0].linkSpeedMbps, 1_000);
  assert.equal(next.hostname, 'test-host'); assert.equal(next.uptimeSeconds, 42);
  subject.close();
});

test('RAM uses total minus available, not Linux free-only accounting', async () => {
  const subject = fixture();
  const snapshot = await subject.getServerStatus();
  assert.deepEqual(snapshot.memory, { totalBytes: 1_000, usedBytes: 600, availableBytes: 400, freeBytes: 100,
    cacheBytes: 250, usedPercent: 60, swapTotalBytes: 100, swapUsedBytes: 25 });
  subject.close();
});

test('filesystem capacities are deduplicated, virtual mounts excluded and RAID media follows members', async () => {
  const subject = fixture({
    fsSize: async () => [
      { fs: '/dev/md2', type: 'ext4', size: 1_000, used: 600, available: 350, mount: '/' },
      { fs: '/dev/md2', type: 'ext4', size: 1_000, used: 600, available: 350, mount: '/bound' },
      { fs: '/dev/md127', type: 'xfs', size: 3_000, used: 1_000, available: 2_000, mount: '/mnt/hdd' },
      { fs: '/dev/loop8', type: 'xfs', size: 4_000, used: 0, available: 4_000, mount: '/build' },
      { fs: 'overlay', type: 'overlay', size: 1_000, used: 600, available: 350, mount: '/docker' },
      { fs: '/dev/mixed', type: 'ext4', size: 100, used: 10, available: 90, mount: '/mixed' },
      { fs: '/dev/sdc1', type: 'ext4', size: 100, used: 10, available: 90, mount: '/ssd' },
    ],
    blockDevices: async () => [
      { name: 'nvme0n1', type: 'disk', physical: 'SSD' }, { name: 'nvme1n1', type: 'disk', physical: 'SSD' },
      { name: 'nvme0n1p3', type: 'part', group: 'md2' }, { name: 'nvme1n1p3', type: 'part', group: 'md2' },
      { name: 'md2', type: 'raid1', mount: '/' },
      { name: 'sda', type: 'disk', physical: 'HDD', group: 'md127' }, { name: 'sdb', type: 'disk', physical: 'HDD', group: 'md127' },
      { name: 'md127', type: 'raid0', mount: '/mnt/hdd' },
      { name: 'sdc', type: 'disk', physical: 'SSD' }, { name: 'sdc1', type: 'part' },
      { name: 'nvme0n1p4', type: 'part', group: 'mixed' }, { name: 'sdd', type: 'disk', physical: 'HDD', group: 'mixed' },
    ],
  });
  const snapshot = await subject.getServerStatus();
  assert.equal(snapshot.storage?.volumes.length, 4);
  assert.equal(snapshot.storage?.volumes.find((volume) => volume.device === '/dev/md2')?.medium, 'nvme');
  assert.equal(snapshot.storage?.volumes.find((volume) => volume.device === '/dev/md2')?.mount, '/');
  assert.equal(snapshot.storage?.volumes.find((volume) => volume.device === '/dev/md127')?.medium, 'hdd');
  assert.equal(snapshot.storage?.volumes.find((volume) => volume.device === '/dev/sdc1')?.medium, 'ssd');
  assert.equal(snapshot.storage?.volumes.find((volume) => volume.device === '/dev/mixed')?.medium, 'other');
  assert.ok(snapshot.warnings.includes('storage_medium_unknown'));
  for (const volume of snapshot.storage!.volumes) assert.equal(volume.usedBytes + volume.availableBytes + volume.reservedBytes, volume.totalBytes);
  assert.equal(snapshot.storage?.volumes.find((volume) => volume.device === '/dev/md2')?.reservedBytes, 50);
  subject.close();
});

test('unknown media stays unknown instead of guessing from the HDD mount name; cyclic metadata terminates', async () => {
  const subject = fixture({
    fsSize: async () => [{ fs: '/dev/unknown', mount: '/mnt/hdd', type: 'xfs', size: 100, used: 10, available: 90 }],
    blockDevices: async () => [{ name: 'unknown', group: 'cycle' }, { name: 'cycle', group: 'unknown' }],
  });
  assert.equal((await subject.getServerStatus()).storage?.volumes[0].medium, 'other');
  subject.close();
});

test('Linux sysfs adapter resolves nested RAID/LVM and partition ancestry without shelling out', async () => {
  const names = ['nvme0n1', 'nvme0n1p3', 'md2', 'dm-0', 'sda', 'sdb', 'md127', 'odd-part', 'loop8', 'nbd0', '../unsafe'];
  const groups: Record<string, string[]> = { md2: ['nvme0n1p3'], 'dm-0': ['md2'], md127: ['sda', 'sdb'] };
  const requested: string[] = [];
  const metadata = await readLinuxBlockMetadata({
    readdir: async (path) => {
      requested.push(path);
      return path === '/sys/class/block' ? names : groups[path.split('/')[4]] || [];
    },
    readFile: async (path) => {
      requested.push(path);
      const name = path.split('/')[4];
      if (path.endsWith('/partition')) {
        if (name === 'nvme0n1p3' || name === 'odd-part') return '3\n';
        throw new Error('ENOENT');
      }
      return name === 'sda' || name === 'sdb' ? '1\n' : '0\n';
    },
    realpath: async (path) => {
      requested.push(path);
      const name = path.split('/')[4];
      return name === 'odd-part' ? '/sys/devices/pci/block/sda/odd-part' : `/sys/devices/pci/block/nvme0n1/${name}`;
    },
  });
  assert.ok(metadata.some((row) => row.name === 'nvme0n1p3' && row.group === 'md2'));
  assert.ok(metadata.some((row) => row.name === 'md2' && row.group === 'dm-0'));
  assert.ok(metadata.some((row) => row.name === 'odd-part' && row.parent === 'sda'));
  assert.ok(!requested.some((path) => /unsafe|loop8|nbd0/.test(path)));
  const subject = fixture({ blockDevices: async () => metadata, fsSize: async () => [
    { fs: '/dev/dm-0', mount: '/', type: 'ext4', size: 100, used: 10, available: 90 },
    { fs: '/dev/md127', mount: '/mnt/hdd', type: 'xfs', size: 100, used: 10, available: 90 },
    { fs: '/dev/odd-part', mount: '/part', type: 'ext4', size: 100, used: 10, available: 90 },
  ] });
  const snapshot = await subject.getServerStatus();
  assert.deepEqual(snapshot.storage?.volumes.map((volume) => volume.medium), ['nvme', 'hdd', 'hdd']);
  subject.close();
});

test('coalesces simultaneous clients, caches snapshot and refreshes slow metadata only after its TTL', async () => {
  const subject = fixture();
  const snapshots = await Promise.all(Array.from({ length: 40 }, () => subject.getServerStatus()));
  assert.ok(snapshots.every((snapshot) => snapshot === snapshots[0]));
  assert.equal(subject.calls.currentLoad, 1); assert.equal(subject.calls.blockDevices, 1);
  subject.advance(999);
  assert.equal(await subject.getServerStatus(), snapshots[0]);
  subject.advance(1_001); await subject.getServerStatus();
  assert.equal(subject.calls.currentLoad, 2); assert.equal(subject.calls.blockDevices, 1);
  assert.equal(subject.calls.fsSize, 1);
  subject.advance(60_000); await subject.getServerStatus();
  assert.equal(subject.calls.blockDevices, 2); assert.equal(subject.calls.networkInterfaces, 2);
  assert.equal(subject.calls.fsSize, 2);
  subject.close();
});

test('counter resets and long sample gaps produce pending rates, never negative or misleading averages', async () => {
  const subject = fixture();
  await subject.getServerStatus();
  subject.advance(2_000); subject.setCounters(5, 10);
  const reset = await subject.getServerStatus();
  assert.equal(reset.network?.[0].receiveBytesPerSecond, null);
  assert.equal(reset.network?.[0].transmitBytesPerSecond, null);
  subject.advance(2_000); subject.setCounters(2_005, 1_010);
  assert.equal((await subject.getServerStatus()).network?.[0].receiveBytesPerSecond, 1_000);
  subject.advance(60_000); subject.setCounters(6_005, 3_010);
  const gap = await subject.getServerStatus();
  assert.equal(gap.cpu?.usedPercent, null); assert.equal(gap.sampleIntervalMs, null);
  assert.equal(gap.network?.[0].receiveBytesPerSecond, null);
  subject.close();
});

test('provider errors are section-local, non-sensitive and invalidate live CPU and memory', async () => {
  const error = async () => { throw new Error('SECRET provider diagnostic /private/token'); };
  const subject = fixture({ currentLoad: error, mem: error, networkStats: error });
  const snapshot = await subject.getServerStatus();
  assert.equal(snapshot.cpu, null); assert.equal(snapshot.memory, null); assert.equal(snapshot.network, null);
  assert.equal(snapshot.storage?.volumes[0].medium, 'nvme');
  assert.ok(snapshot.warnings.includes('cpu_unavailable')); assert.ok(snapshot.warnings.includes('memory_unavailable'));
  assert.ok(snapshot.warnings.includes('network_unavailable')); assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  subject.close();
});

test('missing available RAM is unavailable rather than invented available or used bytes', async () => {
  const subject = fixture({ mem: async () => ({ total: 1_000, free: 50 }) });
  const snapshot = await subject.getServerStatus();
  assert.equal(snapshot.memory, null); assert.ok(snapshot.warnings.includes('memory_unavailable'));
  subject.close();
});

test('interface names are allowlisted, virtual/internal links excluded, external default route retained', async () => {
  let requestedNames = '';
  const subject = fixture({
    networkInterfaces: async () => [
      { iface: 'lo', internal: true, default: false }, { iface: 'veth123', virtual: true },
      { iface: 'bad;name', default: true }, { iface: '../escape', default: true }, { iface: '-option', default: true },
      { iface: 'eth0', default: false, virtual: false, speed: -1 }, { iface: 'eth0', default: false, speed: -1 },
      { iface: 'vpn0', virtual: true, default: true, speed: null },
    ],
    networkStats: async (names) => { requestedNames = names; return [
      { iface: 'eth0', rx_bytes: 100, tx_bytes: 100 }, { iface: 'vpn0', rx_bytes: 200, tx_bytes: 200 },
      { iface: 'private', rx_bytes: 9, tx_bytes: 9 },
    ]; },
  });
  const snapshot = await subject.getServerStatus();
  assert.equal(requestedNames, 'vpn0,eth0');
  assert.deepEqual(snapshot.network?.map((row) => row.name), ['vpn0', 'eth0']);
  assert.equal(snapshot.network?.[0].linkSpeedMbps, null);
  assert.equal(snapshot.network?.[1].linkSpeedMbps, null);
  subject.close();
});

test('hung section is bounded and repeated polls never launch overlapping provider work', async () => {
  let release!: (value: Awaited<ReturnType<ServerStatusEngine['blockDevices']>>) => void;
  const neverUntilReleased = new Promise<Awaited<ReturnType<ServerStatusEngine['blockDevices']>>>((resolve) => { release = resolve; });
  const subject = fixture({ blockDevices: () => neverUntilReleased });
  const first = await subject.getServerStatus();
  assert.ok(first.warnings.includes('storage_metadata_pending'));
  assert.equal(first.storage?.volumes[0].medium, 'other');
  for (let attempt = 0; attempt < 30; attempt++) { subject.advance(2_000); await subject.getServerStatus(); }
  assert.equal(subject.calls.blockDevices, 1);
  release([{ name: 'nvme0n1p3', group: 'md2' }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  subject.advance(2_000);
  const recovered = await subject.getServerStatus();
  assert.equal(subject.calls.blockDevices, 1);
  assert.equal(recovered.storage?.volumes[0].medium, 'nvme');
  assert.ok(!recovered.warnings.includes('storage_metadata_pending'));
  subject.close();
});

test('a storage refresh failure retains its actual sample timestamp and explicitly reports stale data', async () => {
  let reads = 0;
  const subject = fixture({ fsSize: async () => {
    if (reads++) throw new Error('disk stats temporarily unavailable');
    return [{ fs: '/dev/md2', type: 'ext4', mount: '/', size: 100, used: 20, available: 75 }];
  } });
  const first = await subject.getServerStatus();
  subject.advance(6_000);
  const stale = await subject.getServerStatus();
  assert.equal(stale.storage?.sampledAt, first.storage?.sampledAt);
  assert.ok(stale.warnings.includes('storage_stale'));
  assert.notEqual(stale.sampledAt, first.sampledAt);
  subject.close();
});

test('numeric output is finite and bounded and provider-only details never escape the owned contract', async () => {
  const subject = fixture({
    cpu: async () => ({ brand: 'Test\u0000 CPU', cores: 2, private: 'SECRET' } as unknown as Awaited<ReturnType<ServerStatusEngine['cpu']>>),
    currentLoad: async () => ({ currentLoad: 200, cpus: [{ load: -1 }, { load: NaN }] }),
    networkStats: async () => [{ iface: 'eth0', rx_bytes: -1, tx_bytes: Infinity }],
  });
  await subject.getServerStatus(); subject.advance(2_000);
  const snapshot = await subject.getServerStatus();
  assert.equal(snapshot.cpu?.usedPercent, 100); assert.deepEqual(snapshot.cpu?.cores, [0, null]);
  assert.equal(snapshot.cpu?.model, 'Test CPU'); assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  assert.deepEqual(snapshot.network, []); assert.ok(snapshot.warnings.includes('network_partial'));
  subject.close();
  await assert.rejects(subject.getServerStatus(), /closed/);
});
