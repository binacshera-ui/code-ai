import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { fleetClient } from '../focus-notifications-20261020/fleet-live.mjs';
const root = '/root/projects/code-ai', ops = root + '/ops/server-status-20261021';
const staged = JSON.parse(await fs.readFile(ops + '/staged.json', 'utf8'));
const candidate = process.argv[2] === 'candidate';
const collector = candidate ? (await import(pathToFileURL(staged.candidate + '/server/serverStatus.ts'))).createServerStatusCollector() : null;
const api = candidate ? null : await fleetClient();
const read = candidate ? () => collector.getServerStatus() : () => api('local', '/server-status');
const times = [];
let snapshot;
try {
  for (let i = 0; i < 3; i++) {
    const at = performance.now(); snapshot = await read(); times.push(Math.round(performance.now() - at));
    if (i < 2) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  assert.equal(snapshot.version, 1); assert.equal(snapshot.hostname, os.hostname());
  assert.equal(snapshot.cpu.logicalCores, os.cpus().length);
  assert.equal(snapshot.memory.totalBytes, os.totalmem());
  assert.ok(snapshot.cpu.usedPercent >= 0 && snapshot.cpu.usedPercent <= 100);
  assert.equal(snapshot.cpu.freePercent, 100 - snapshot.cpu.usedPercent);
  assert.ok(snapshot.cpu.cores.length === os.cpus().length && snapshot.cpu.cores.every(v => v !== null));
  assert.equal(snapshot.memory.usedBytes + snapshot.memory.availableBytes, snapshot.memory.totalBytes);
  const volumes = snapshot.storage.volumes;
  for (const [mount, medium] of [['/', 'nvme'], ['/mnt/hdd', 'hdd']]) {
    const actual = volumes.find(v => v.mount === mount); assert.ok(actual); assert.equal(actual.medium, medium);
    const stat = await fs.statfs(mount); assert.equal(actual.totalBytes, stat.blocks * stat.bsize);
    assert.ok(Math.abs(actual.availableBytes - stat.bavail * stat.bsize) < actual.totalBytes * .002);
    assert.equal(actual.totalBytes, actual.usedBytes + actual.availableBytes + actual.reservedBytes);
  }
  assert.equal(new Set(volumes.map(v => v.device)).size, volumes.length);
  assert.ok(!volumes.some(v => /overlay|\/dev\/loop/.test(v.device)));
  const nic = snapshot.network.find(n => n.isDefault); assert.ok(nic);
  const link = Number((await fs.readFile('/sys/class/net/' + nic.name + '/speed', 'utf8')).trim());
  assert.equal(nic.linkSpeedMbps, link); assert.ok(nic.receiveBytesPerSecond >= 0 && nic.transmitBytesPerSecond >= 0);
  assert.deepEqual(snapshot.warnings, []);
  const receipt = { passed: true, source: candidate ? 'isolated candidate collector' : 'authenticated live API',
    checkedAt: new Date().toISOString(), sampleDurationsMs: times,
    independentlyVerified: ['hostname', 'logical CPU count', 'RAM total', 'statfs capacity and free', 'RAID media', 'network link speed'],
    snapshot };
  await fs.writeFile(ops + '/' + (candidate ? 'candidate-metrics' : 'live-metrics') + '.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, source: receipt.source, sampleDurationsMs: times, hostname: snapshot.hostname,
    logicalCores: snapshot.cpu.logicalCores, memoryBytes: snapshot.memory.totalBytes,
    volumes: volumes.map(v => ({ mount: v.mount, medium: v.medium, totalBytes: v.totalBytes, availableBytes: v.availableBytes })),
    defaultInterface: nic.name, linkSpeedMbps: nic.linkSpeedMbps }));
} finally { collector?.close(); }
