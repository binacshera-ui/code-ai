import os from 'node:os';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import type { ServerStatusSnapshot, ServerStatusVolume, StorageMedium } from '../shared/serverStatus.js';

/** Only the fields used by our contract, not the provider's much wider objects. */
export interface ServerStatusEngine {
  cpu(): Promise<{ brand?: string; manufacturer?: string; cores?: number }>;
  currentLoad(): Promise<{ currentLoad?: number; cpus?: Array<{ load?: number }> }>;
  mem(): Promise<{ total?: number; available?: number; free?: number; cached?: number; buffers?: number; swaptotal?: number; swapused?: number }>;
  fsSize(): Promise<Array<{ fs?: string; type?: string; size?: number; used?: number; available?: number; mount?: string }>>;
  blockDevices(): Promise<Array<{ name?: string; type?: string; group?: string; physical?: string; mount?: string; parent?: string }>>;
  networkInterfaces(): Promise<Array<{ iface?: string; default?: boolean; internal?: boolean; virtual?: boolean; operstate?: string; speed?: number | null }>>;
  networkStats(names: string): Promise<Array<{ iface?: string; operstate?: string; rx_bytes?: number; tx_bytes?: number }>>;
}

export interface ServerStatusCollectorOptions {
  engine?: ServerStatusEngine;
  wallNow?: () => number;
  monotonicNow?: () => number;
  cacheMs?: number;
  metadataMs?: number;
  timeoutMs?: number;
  maxSampleGapMs?: number;
  host?: { hostname(): string; platform(): string; uptime(): number; loadAverage(): number[] };
}

type Reading<T> = { value: T; monotonicAt: number; wallAt: number };
type ReadResult<T> = { reading: Reading<T> | null; status: 'ok' | 'unavailable' | 'pending' | 'stale' };
type InterfaceInfo = Awaited<ReturnType<ServerStatusEngine['networkInterfaces']>>[number];
type FileSystemInfo = Awaited<ReturnType<ServerStatusEngine['fsSize']>>[number];
type BlockInfo = Awaited<ReturnType<ServerStatusEngine['blockDevices']>>[number];

export interface ServerStatusLinuxFiles {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
}

const interfaceName = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bytes = (value: unknown) => finite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
const percent = (value: unknown) => finite(value) ? Math.min(100, Math.max(0, value)) : null;
const label = (value: unknown, limit = 128) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : '';
const basename = (name: string) => name.replace(/^\/dev\//, '').split('/').at(-1) || '';
const isLocalVolume = (row: FileSystemInfo) => typeof row.fs === 'string' && /^\/dev\//.test(row.fs)
  && !/^\/dev\/(?:loop|ram|zram|fd)\d/.test(row.fs)
  && !/^(?:overlay|squashfs|tmpfs|devtmpfs|proc|sysfs|ramfs)$/i.test(row.type || '');

/** Read the kernel's existing block graph. SI's Linux blockDevices() invokes
 * mdadm synchronously for every RAID device, which would stall the API loop.
 * The dashboard needs only ancestry and rotational media, not SMART/serials. */
export async function readLinuxBlockMetadata(files: ServerStatusLinuxFiles = {
  readdir: (path) => readdir(path), readFile: (path) => readFile(path, 'utf8'), realpath,
}): ReturnType<ServerStatusEngine['blockDevices']> {
  const safeName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(name);
  const names = (await files.readdir('/sys/class/block')).filter((name) => safeName(name)
    && !/^(?:loop|ram|zram|nbd|fd)\d/.test(name)).sort().slice(0, 512);
  const entries = await Promise.all(names.map(async (name) => {
    const root = `/sys/class/block/${name}`;
    const [rotational, partition, target, members] = await Promise.all([
      files.readFile(`${root}/queue/rotational`).catch(() => ''),
      files.readFile(`${root}/partition`).then(() => true, () => false),
      files.realpath(root).catch(() => ''),
      files.readdir(`${root}/slaves`).catch(() => []),
    ]);
    const parent = partition ? target.split('/').slice(0, -1).at(-1) : undefined;
    const physical = rotational.trim() === '1' ? 'HDD' : rotational.trim() === '0' ? 'SSD' : '';
    return { name, type: partition ? 'part' : members.length ? 'raid' : 'disk',
      physical: !partition && !/^(?:md\d+|dm-\d+)$/.test(name) ? physical : '',
      parent: parent && safeName(parent) ? parent : undefined,
      members: members.filter(safeName).slice(0, 512) };
  }));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const rows: BlockInfo[] = entries.map(({ members: _members, ...entry }) => entry);
  for (const entry of entries) for (const member of entry.members) {
    const child = byName.get(member);
    // One block may have several holders. Keep each edge rather than silently
    // overwriting a group; the normalizer deliberately supports repeated rows.
    rows.push({ name: member, type: child?.type, physical: child?.physical, parent: child?.parent, group: entry.name });
  }
  return rows;
}

/** Linux SI interface discovery shells out per veth. Read only narrow sysfs
 * metadata instead; counters still come from SI with explicit validated names. */
async function linuxInterfaces(): ReturnType<ServerStatusEngine['networkInterfaces']> {
  const [names, routeText] = await Promise.all([
    readdir('/sys/class/net'),
    readFile('/proc/net/route', 'utf8').catch(() => ''),
  ]);
  const defaultNames = new Set(routeText.split('\n').slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1] === '00000000' && (Number.parseInt(fields[3] || '0', 16) & 1) !== 0
      && interfaceName.test(fields[0] || '') ? [fields[0]] : [];
  }));
  const candidates = names.filter((name) => interfaceName.test(name) && name !== 'lo').sort();
  const selected = await Promise.all(candidates.map(async (name) => {
    const physical = await access(`/sys/class/net/${name}/device`).then(() => true, () => false);
    if (!physical && !defaultNames.has(name)) return null;
    const [state, speed] = await Promise.all([
      readFile(`/sys/class/net/${name}/operstate`, 'utf8').catch(() => 'unknown'),
      readFile(`/sys/class/net/${name}/speed`, 'utf8').catch(() => ''),
    ]);
    const parsedSpeed = Number.parseInt(speed, 10);
    return { iface: name, default: defaultNames.has(name), internal: false, virtual: !physical,
      operstate: label(state.trim(), 24), speed: parsedSpeed > 0 ? parsedSpeed : null };
  }));
  return selected.filter((row): row is NonNullable<typeof row> => row !== null).slice(0, 16);
}

function localEngine(): ServerStatusEngine {
  // Loading this module does not probe the host or start background work.
  const require = createRequire(import.meta.url);
  let provider: ServerStatusEngine | null = null;
  const get = () => provider ||= require('systeminformation') as ServerStatusEngine;
  return {
    cpu: () => get().cpu(), currentLoad: () => get().currentLoad(), mem: () => get().mem(),
    blockDevices: () => os.platform() === 'linux' ? readLinuxBlockMetadata() : get().blockDevices(),
    fsSize: async () => {
      const rows = (await get().fsSize()).filter(isLocalVolume).slice(0, 128);
      // Resolve aliases so a bind mount or /dev/disk/by-* alias cannot count
      // the same capacity twice. Unresolvable devices retain their honest id.
      return Promise.all(rows.map(async (row) => ({ ...row, fs: await realpath(row.fs!).catch(() => row.fs!) })));
    },
    networkInterfaces: () => os.platform() === 'linux' ? linuxInterfaces() : Promise.reject(new Error('unsupported_platform')),
    networkStats: (names) => get().networkStats(names),
  };
}

function storageVolumes(rows: FileSystemInfo[], blocks: BlockInfo[]): ServerStatusVolume[] {
  const blockMap = new Map(blocks.map((block) => [basename(block.name || ''), block]));
  const groupMembers = new Map<string, string[]>();
  for (const block of blocks) {
    const group = basename(block.group || '');
    if (group) groupMembers.set(group, [...(groupMembers.get(group) || []), basename(block.name || '')]);
  }
  const mediumFor = (name: string, visited = new Set<string>()): StorageMedium => {
    if (!name || visited.has(name)) return 'other';
    visited.add(name);
    if (/^nvme\d+n\d+(?:p\d+)?$/.test(name)) return 'nvme';
    const block = blockMap.get(name);
    const members = groupMembers.get(name);
    if (members?.length) {
      const media = new Set(members.map((member) => mediumFor(member, new Set(visited))));
      return media.size === 1 ? [...media][0] : 'other';
    }
    if (block?.physical === 'HDD') return 'hdd';
    if (block?.physical === 'SSD') return 'ssd';
    // SI provides RAID members and physical disks but not a partition parent
    // field. Only follow an existing, unambiguous Linux parent name.
    const parent = block?.parent || name.replace(/(?:p\d+|\d+)$/, '');
    return parent !== name && blockMap.has(parent) ? mediumFor(parent, visited) : 'other';
  };
  const unique = new Map<string, FileSystemInfo>();
  for (const row of rows.slice(0, 512)) {
    if (!isLocalVolume(row) || !finite(row.size) || row.size <= 0 || !finite(row.used) || !finite(row.available)) continue;
    const previous = unique.get(row.fs!);
    // Prefer the filesystem's canonical mount over a bind mount.
    const mountedBlock = blocks.find((block) => basename(block.name || '') === basename(row.fs!));
    if (!previous || row.mount === mountedBlock?.mount || (row.mount || '').length < (previous.mount || '').length) unique.set(row.fs!, row);
  }
  return [...unique.values()].map((row) => {
    const totalBytes = bytes(row.size);
    const usedBytes = Math.min(totalBytes, bytes(row.used));
    const availableBytes = Math.min(totalBytes - usedBytes, bytes(row.available));
    return { device: label(row.fs, 256), mount: label(row.mount, 256), filesystem: label(row.type, 32),
      medium: mediumFor(basename(row.fs!)), totalBytes, usedBytes, availableBytes,
      reservedBytes: totalBytes - usedBytes - availableBytes, usedPercent: usedBytes / totalBytes * 100 };
  }).sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, 128);
}

function publicInterfaces(rows: InterfaceInfo[]): InterfaceInfo[] {
  const unique = new Map<string, InterfaceInfo>();
  for (const row of rows.slice(0, 512)) {
    if (!row.iface || !interfaceName.test(row.iface) || row.internal || (row.virtual && !row.default)) continue;
    unique.set(row.iface, row);
  }
  return [...unique.values()].sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)) || a.iface!.localeCompare(b.iface!)).slice(0, 16);
}

/** One cache per host process, not per browser. An overdue provider promise
 * stays in its slot until it settles: deadlines never spawn overlapping work. */
export function createServerStatusCollector(options: ServerStatusCollectorOptions = {}) {
  const engine = options.engine || localEngine();
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const wallNow = options.wallNow || Date.now;
  const cacheMs = Math.max(0, options.cacheMs ?? 1_000);
  const metadataMs = Math.max(cacheMs, options.metadataMs ?? 60_000);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 3_000);
  const maxSampleGapMs = Math.max(cacheMs, options.maxSampleGapMs ?? 15_000);
  const host = options.host || { hostname: os.hostname, platform: os.platform, uptime: os.uptime, loadAverage: os.loadavg };
  let closed = false;

  function slot<T>(read: () => Promise<T>) {
    let last: Reading<T> | null = null;
    let pending: { operation: Promise<ReadResult<T>>; wait: Promise<ReadResult<T>> } | null = null;
    let retryAt = -Infinity;
    return async (ttl: number): Promise<ReadResult<T>> => {
      const now = monotonicNow();
      if (last && now - last.monotonicAt >= 0 && now - last.monotonicAt < ttl) return { reading: last, status: 'ok' };
      if (!pending && now >= retryAt && !closed) {
        const operation = Promise.resolve().then(read).then((value): ReadResult<T> => {
          last = { value, monotonicAt: monotonicNow(), wallAt: wallNow() };
          return { reading: last, status: 'ok' };
        }, (): ReadResult<T> => {
          retryAt = monotonicNow() + Math.max(cacheMs, 1_000);
          return { reading: last, status: last ? 'stale' : 'unavailable' };
        });
        // Exactly one deadline and completion listener per underlying call.
        // Repeated dashboard polls cannot accumulate handlers on a hung read.
        const wait = new Promise<ReadResult<T>>((resolve) => {
          const timer = setTimeout(() => resolve({ reading: last, status: last ? 'stale' : 'pending' }), timeoutMs);
          void operation.then((result) => { clearTimeout(timer); resolve(result); });
        });
        pending = { operation, wait };
        void operation.then(() => { if (pending?.operation === operation) pending = null; });
      }
      if (!pending) return { reading: last, status: last ? 'stale' : 'unavailable' };
      return pending.wait;
    };
  }

  const cpuMetadata = slot(() => engine.cpu());
  const cpuLoad = slot(() => engine.currentLoad());
  const memory = slot(() => engine.mem());
  const filesystem = slot(() => engine.fsSize());
  const blockDevices = slot(() => engine.blockDevices());
  const interfaces = slot(() => engine.networkInterfaces());
  let statsNames = '';
  const networkStats = slot(() => engine.networkStats(statsNames));
  let lastCpuAt: number | null = null;
  let lastNetwork = new Map<string, { at: number; received: number; transmitted: number }>();
  let cached: { at: number; snapshot: ServerStatusSnapshot } | null = null;
  let pendingSnapshot: Promise<ServerStatusSnapshot> | null = null;

  async function sample(): Promise<ServerStatusSnapshot> {
    const warnings = new Set<string>();
    const [cpuInfo, load, mem, fs, blocks, nics] = await Promise.all([
      cpuMetadata(metadataMs), cpuLoad(cacheMs), memory(cacheMs),
      filesystem(Math.max(cacheMs, 5_000)), blockDevices(metadataMs), interfaces(metadataMs),
    ]);
    const warn = (section: string, result: ReadResult<unknown>) => {
      if (result.status !== 'ok') warnings.add(`${section}_${result.status === 'pending' ? 'pending' : result.status === 'stale' ? 'stale' : 'unavailable'}`);
    };
    warn('cpu', load); warn('memory', mem); warn('storage', fs); warn('storage_metadata', blocks); warn('network', nics);
    const cpuValue = load.status === 'ok' ? load.reading : null;
    const interval = cpuValue && lastCpuAt !== null ? cpuValue.monotonicAt - lastCpuAt : null;
    const validInterval = interval !== null && interval > 0 && interval <= maxSampleGapMs;
    if (cpuValue && !validInterval) warnings.add('cpu_warming_up');
    const cpuUsed = validInterval ? percent(cpuValue?.value.currentLoad) : null;
    const coreLoads = cpuValue?.value.cpus || [];
    if (cpuValue) lastCpuAt = cpuValue.monotonicAt;
    else lastCpuAt = null;

    const memValue = mem.status === 'ok' ? mem.reading?.value : null;
    const memoryTotal = bytes(memValue?.total);
    const memoryAvailable = Math.min(memoryTotal, bytes(memValue?.available));
    const usableMem = memValue && finite(memValue.available) && memoryTotal > 0;
    if (memValue && !usableMem) warnings.add('memory_unavailable');

    const nicRows = nics.reading ? publicInterfaces(nics.reading.value) : null;
    let network: ServerStatusSnapshot['network'] = null;
    if (nicRows) {
      statsNames = nicRows.map((row) => row.iface!).join(',');
      if (statsNames) {
        const stats = await networkStats(cacheMs);
        warn('network', stats);
        if (stats.status === 'ok' && stats.reading) {
          const next = new Map<string, { at: number; received: number; transmitted: number }>();
          const at = stats.reading.monotonicAt;
          const byName = new Map(stats.reading.value.map((row) => [row.iface, row]));
          network = nicRows.flatMap((nic) => {
            const stat = byName.get(nic.iface);
            if (!stat || !finite(stat.rx_bytes) || !finite(stat.tx_bytes) || stat.rx_bytes < 0 || stat.tx_bytes < 0) return [];
            const received = bytes(stat.rx_bytes); const transmitted = bytes(stat.tx_bytes);
            const previous = lastNetwork.get(nic.iface!);
            const elapsed = previous ? at - previous.at : 0;
            const rateValid = previous && elapsed > 0 && elapsed <= maxSampleGapMs
              && received >= previous.received && transmitted >= previous.transmitted;
            next.set(nic.iface!, { at, received, transmitted });
            return [{ name: nic.iface!, isDefault: Boolean(nic.default), state: label(stat.operstate || nic.operstate || 'unknown', 24),
              linkSpeedMbps: finite(nic.speed) && nic.speed > 0 ? nic.speed : null,
              receivedBytes: received, transmittedBytes: transmitted,
              receiveBytesPerSecond: rateValid ? (received - previous.received) * 1_000 / elapsed : null,
              transmitBytesPerSecond: rateValid ? (transmitted - previous.transmitted) * 1_000 / elapsed : null }];
          });
          if (network.length < nicRows.length) warnings.add('network_partial');
          if (network.some((nic) => nic.receiveBytesPerSecond === null)) warnings.add('network_warming_up');
          lastNetwork = next;
        } else lastNetwork = new Map();
      } else { network = []; lastNetwork = new Map(); }
    } else lastNetwork = new Map();

    const volumes = fs.reading ? storageVolumes(fs.reading.value, blocks.reading?.value || []) : null;
    if (volumes?.some((volume) => volume.medium === 'other')) warnings.add('storage_medium_unknown');
    return {
      version: 1, hostname: label(host.hostname()), platform: label(host.platform(), 32),
      sampledAt: new Date(wallNow()).toISOString(), sampleIntervalMs: validInterval ? interval : null,
      uptimeSeconds: bytes(host.uptime()),
      cpu: cpuValue ? { model: label(cpuInfo.reading?.value.brand || cpuInfo.reading?.value.manufacturer || 'CPU'),
        logicalCores: bytes(cpuInfo.reading?.value.cores) || coreLoads.length,
        usedPercent: cpuUsed, freePercent: cpuUsed === null ? null : 100 - cpuUsed,
        cores: coreLoads.slice(0, 512).map((core) => validInterval ? percent(core.load) : null),
        loadAverage: host.loadAverage().slice(0, 3).map((value) => finite(value) ? Math.max(0, value) : 0) } : null,
      memory: usableMem ? { totalBytes: memoryTotal, usedBytes: memoryTotal - memoryAvailable,
        availableBytes: memoryAvailable, freeBytes: Math.min(memoryTotal, bytes(memValue.free)),
        cacheBytes: Math.min(memoryTotal, bytes(memValue.cached) + bytes(memValue.buffers)),
        usedPercent: (memoryTotal - memoryAvailable) / memoryTotal * 100,
        swapTotalBytes: bytes(memValue.swaptotal), swapUsedBytes: Math.min(bytes(memValue.swaptotal), bytes(memValue.swapused)) } : null,
      storage: volumes && fs.reading ? { sampledAt: new Date(fs.reading.wallAt).toISOString(), volumes } : null,
      network, warnings: [...warnings].sort(),
    };
  }

  return {
    getServerStatus(): Promise<ServerStatusSnapshot> {
      if (closed) return Promise.reject(new Error('Server status collector is closed'));
      const now = monotonicNow();
      if (cached && now - cached.at >= 0 && now - cached.at < cacheMs) return Promise.resolve(cached.snapshot);
      if (!pendingSnapshot) {
        const operation = sample().then((snapshot) => { cached = { at: monotonicNow(), snapshot }; return snapshot; });
        pendingSnapshot = operation;
        void operation.then(() => { if (pendingSnapshot === operation) pendingSnapshot = null; }, () => { if (pendingSnapshot === operation) pendingSnapshot = null; });
      }
      return pendingSnapshot;
    },
    close() { closed = true; cached = null; },
  };
}

let collector: ReturnType<typeof createServerStatusCollector> | null = null;
export function getServerStatus(): Promise<ServerStatusSnapshot> {
  collector ||= createServerStatusCollector();
  return collector.getServerStatus();
}
