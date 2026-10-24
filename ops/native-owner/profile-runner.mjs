/** Starts only the explicit qualified profile owner; never migrates/stops other writers. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { nativeOwnerArguments, validateProfilePlan } from './profile-artifacts.mjs';

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await fs.lstat(directory);
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) throw new Error('Owner directory unavailable');
}

async function requireAbsent(filename) {
  try { await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Do not unlink a native daemon socket or its legitimate canonical symlink.
  throw new Error('Existing endpoint requires explicit migration');
}

async function fileIdentity(filename, socket = false) {
  const entry = await fs.lstat(filename, { bigint: true });
  if ((socket ? !entry.isSocket() : !entry.isFile()) || entry.uid !== BigInt(process.getuid())
      || (!socket && (entry.mode & 0o077n))) throw new Error('Owned record unavailable');
  return { dev: entry.dev.toString(), ino: entry.ino.toString(), uid: entry.uid.toString() };
}

function sameEntry(actual, expected) {
  return expected && actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid;
}

function validEntry(entry) {
  return entry && ['dev', 'ino', 'uid'].every(key => /^[0-9]+$/.test(entry[key] || ''));
}

function validNativeAliasRecord(recorded) {
  return recorded?.kind === 'native-alias' && validEntry(recorded) && validEntry(recorded.target)
    && validEntry(recorded.target.parent) && recorded.uid === String(process.getuid())
    && recorded.target.uid === recorded.uid && recorded.target.parent.uid === recorded.uid
    && path.isAbsolute(recorded.target.path || '')
    && path.basename(path.dirname(recorded.target.path)) === `codex-daemon-${process.getuid()}`
    && /^[a-f0-9]{64}$/.test(path.basename(recorded.target.path));
}

async function endpointIdentity(filename, allowNativeAlias = false, recorded = null) {
  const entry = await fs.lstat(filename, { bigint: true });
  const identity = { dev: entry.dev.toString(), ino: entry.ino.toString(), uid: entry.uid.toString() };
  if (entry.uid !== BigInt(process.getuid())) throw new Error('Endpoint owner unavailable');
  if (entry.isSocket()) return { ...identity, kind: 'socket' };
  if (!allowNativeAlias || !entry.isSymbolicLink()) throw new Error('Endpoint type unavailable');
  const aliasParent = await fs.lstat(path.dirname(filename), { bigint: true });
  if (!aliasParent.isDirectory() || aliasParent.uid !== entry.uid || (aliasParent.mode & 0o077n)) throw new Error('Alias parent unavailable');
  const targetPath = path.resolve(path.dirname(filename), await fs.readlink(filename));
  const targetParent = path.dirname(targetPath);
  if (path.basename(targetParent) !== `codex-daemon-${process.getuid()}`
      || !/^[a-f0-9]{64}$/.test(path.basename(targetPath))) throw new Error('Native alias target unavailable');
  let parent;
  try { parent = await fs.lstat(targetParent, { bigint: true }); }
  catch (error) {
    if (error.code !== 'ENOENT' || !validNativeAliasRecord(recorded)
        || recorded.target?.path !== targetPath || !sameEntry(identity, recorded)) throw error;
    return { ...identity, kind: 'native-alias', target: { path: targetPath, missing: true } };
  }
  if (!parent.isDirectory() || parent.uid !== entry.uid || (parent.mode & 0o077n)
      || await fs.realpath(targetParent) !== targetParent) throw new Error('Native target parent unavailable');
  const parentIdentity = { dev: parent.dev.toString(), ino: parent.ino.toString(), uid: parent.uid.toString() };
  let target;
  try { target = await fs.lstat(targetPath, { bigint: true }); }
  catch (error) {
    if (error.code !== 'ENOENT' || !validNativeAliasRecord(recorded)
        || recorded.target?.path !== targetPath || !sameEntry(identity, recorded)) throw error;
    return { ...identity, kind: 'native-alias', target: { path: targetPath, missing: true } };
  }
  if (!target.isSocket() || target.uid !== entry.uid || await fs.realpath(filename) !== targetPath) throw new Error('Native target unavailable');
  return { ...identity, kind: 'native-alias', target: { path: targetPath, dev: target.dev.toString(),
    ino: target.ino.toString(), uid: target.uid.toString(), parent: parentIdentity } };
}

function sameEndpoint(actual, recorded) {
  if (!sameEntry(actual, recorded) || actual.kind !== recorded.kind) return false;
  if (actual.kind !== 'native-alias') return true;
  if (!validNativeAliasRecord(recorded)) return false;
  if (actual.target.path !== recorded.target?.path) return false;
  return actual.target.missing === true || (sameEntry(actual.target, recorded.target)
    && sameEntry(actual.target.parent, recorded.target.parent));
}

async function processIdentity(pid) {
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  if (Number(/^Uid:\s+([0-9]+)/m.exec(status)?.[1]) !== process.getuid()) throw new Error('Process owner unavailable');
  const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/);
  if (!/^[0-9]+$/.test(fields[19] || '')) throw new Error('Process generation unavailable');
  return { startTime: fields[19], executable: await fs.realpath(`/proc/${pid}/exe`),
    cgroupSha256: createHash('sha256').update(await fs.readFile(`/proc/${pid}/cgroup`)).digest('hex'),
    networkNamespace: await fs.readlink(`/proc/${pid}/ns/net`) };
}

async function kernelSocketInodes(filename, listeningOnly = false) {
  return (await fs.readFile('/proc/net/unix', 'utf8')).split('\n').flatMap(line => {
    const match = /^\S+:\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || match[5] !== filename) return [];
    // Accepted stream connections retain the listener pathname in /proc/net/unix.
    // Custody must prove the SO_ACCEPTCON stream FD, not count those clients.
    if (listeningOnly && (!/^[a-f0-9]+$/i.test(match[1]) || !(BigInt(`0x${match[1]}`) & 0x10000n)
        || match[2] !== '0001' || match[3] !== '01')) return [];
    return [match[4]];
  });
}

async function proveNativeListener(plan, endpoint, nativePid) {
  const identity = await processIdentity(nativePid), runnerIdentity = await processIdentity(process.pid);
  if (identity.cgroupSha256 !== runnerIdentity.cgroupSha256
      || identity.networkNamespace !== runnerIdentity.networkNamespace) throw new Error('Native process custody unavailable');
  const program = await fs.readFile(plan.nativeBinary);
  if (program.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
    if (identity.executable !== await fs.realpath(plan.nativeBinary)) throw new Error('Native process executable unavailable');
  } else {
    // Explicit pinned shebang fixture/program: prove its qualified interpreter and script argument.
    const args = (await fs.readFile(`/proc/${nativePid}/cmdline`)).toString().split('\0');
    if (identity.executable !== await fs.realpath(plan.nodeBinary)
        || !args.includes(plan.nativeBinary)) throw new Error('Native interpreter custody unavailable');
  }
  const address = endpoint.kind === 'native-alias' ? endpoint.target.path : path.join(plan.ownerDirectory, 'engine.sock');
  const inodes = await kernelSocketInodes(address, true);
  if (inodes.length !== 1) throw new Error('Native listener identity unavailable');
  const descriptors = await fs.readdir(`/proc/${nativePid}/fd`);
  let matched = false;
  for (const descriptor of descriptors) {
    try { if (await fs.readlink(`/proc/${nativePid}/fd/${descriptor}`) === `socket:[${inodes[0]}]`) matched = true; }
    catch { /* A non-listener descriptor may close while enumerating. */ }
  }
  if (!matched || (await processIdentity(nativePid)).startTime !== identity.startTime) throw new Error('Native listener process unavailable');
  return identity;
}

async function listenerLiveOrUncertain(filename) {
  return new Promise(resolve => {
    const socket = new WebSocket(`ws+unix://${filename}:/`, { handshakeTimeout: 1000 });
    let settled = false;
    const finish = result => { if (settled) return; settled = true; socket.terminate(); resolve(result); };
    socket.once('open', () => finish(true));
    socket.on('error', error => finish(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
  });
}

async function proveRecordedNativeTargetGone(recorded) {
  if (!validNativeAliasRecord(recorded)) throw new Error('Native alias record unavailable');
  // Even a removed/dangling alias cannot conceal a daemon surviving its launcher.
  if ((await kernelSocketInodes(recorded.target.path)).length || await listenerLiveOrUncertain(recorded.target.path)) {
    throw new Error('Native listener still present or uncertain');
  }
  let target;
  try { target = await fs.lstat(recorded.target.path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const actual = { dev: target.dev.toString(), ino: target.ino.toString(), uid: target.uid.toString() };
  const parent = await fs.lstat(path.dirname(recorded.target.path), { bigint: true });
  const parentEntry = { dev: parent.dev.toString(), ino: parent.ino.toString(), uid: parent.uid.toString() };
  if (!target.isSocket() || !sameEntry(actual, recorded.target) || !parent.isDirectory()
      || (parent.mode & 0o077n) || !sameEntry(parentEntry, recorded.target.parent)
      || await fs.realpath(path.dirname(recorded.target.path)) !== path.dirname(recorded.target.path)) {
    throw new Error('Native target changed');
  }
}

async function proveHeldLock(filename) {
  const entry = await fs.lstat(filename, { bigint: true });
  const major = (entry.dev >> 8n) & 0xfffn;
  const minor = (entry.dev & 0xffn) | ((entry.dev >> 12n) & 0xffffff00n);
  const locks = await fs.readFile('/proc/locks', 'utf8');
  const held = locks.split('\n').some(line => {
    const fields = line.trim().split(/\s+/); const device = fields[5]?.split(':');
    return fields[1] === 'FLOCK' && fields[4] === String(process.pid) && device?.length === 3
      && BigInt(parseInt(device[0], 16)) === major && BigInt(parseInt(device[1], 16)) === minor
      && device[2] === entry.ino.toString();
  });
  if (!held) throw new Error('Exclusive owner custody missing');
}

async function isDead(pid, recorded) {
  if (!Number.isInteger(pid) || pid < 1 || !/^[0-9]+$/.test(recorded?.startTime || '')
      || !path.isAbsolute(recorded?.executable || '') || !/^[a-f0-9]{64}$/.test(recorded?.cgroupSha256 || '')) return false;
  try {
    process.kill(pid, 0);
    // A terminated, unreaped zombie cannot hold a listener or native writer FD.
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    return /^State:\s+Z\b/m.test(status) || (await processIdentity(pid)).startTime !== recorded.startTime;
  } catch (error) { return error.code === 'ESRCH'; }
}

async function recoverRecordedSockets(plan, backendSocket) {
  const filename = path.join(plan.ownerDirectory, 'ownership.json');
  try { await fileIdentity(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const previous = JSON.parse(await fs.readFile(filename, 'utf8'));
  const currentBoot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const previousBootEnded = typeof previous.bootId === 'string' && /^[a-f0-9-]{36}$/.test(previous.bootId)
    && previous.bootId !== currentBoot;
  if (previous.format !== 'code-ai-native-owner-custody' || previous.version !== 2
      || previous.profileId !== plan.profileId || previous.codexHome !== await fs.realpath(plan.codexHome)
      || previous.backendSocket !== backendSocket || previous.frontendSocket !== plan.frontendSocket
      || (!previousBootEnded && (!await isDead(previous.runnerPid, previous.runnerIdentity)
        || !await isDead(previous.nativePid, previous.nativeIdentity)))) throw new Error('Previous owner custody unresolved');
  const verified = [];
  for (const [filename, recorded] of [[backendSocket, previous.backend], [plan.frontendSocket, previous.frontend]]) {
    if (filename === backendSocket && recorded?.kind === 'native-alias') await proveRecordedNativeTargetGone(recorded);
    let entry;
    try { entry = await endpointIdentity(filename, filename === backendSocket, recorded); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (previous.nativeBinarySha256 !== plan.nativeBinarySha256 || previous.brokerModuleSha256 !== plan.brokerModuleSha256) {
      throw new Error('Stale endpoint requires its qualified predecessor');
    }
    if (!sameEndpoint(entry, recorded)) throw new Error('Unrecorded endpoint');
    if (entry.kind === 'native-alias' && (await kernelSocketInodes(entry.target.path)).length !== 0) throw new Error('Native listener still present');
    // A live listener must never be removed, even if both recorded PIDs died.
    const listening = await listenerLiveOrUncertain(filename);
    if (listening) throw new Error('Endpoint still live or uncertain');
    verified.push([filename, recorded]);
  }
  for (const [filename, recorded] of verified) {
    const current = await endpointIdentity(filename, filename === backendSocket, recorded);
    if (!sameEndpoint(current, recorded)) throw new Error('Endpoint changed');
    // Held persistent OS flock serializes our owners; only recorded dead-owner socket inodes are removed.
    await fs.unlink(filename);
  }
}

/** One-use, pinned handoff of the existing writer, never a second native process.
 * The systemd migration keeps this native PID in the same service cgroup.
 */
async function adoptRecordedNative(plan, backendSocket) {
  const ticketPath = path.join(plan.ownerDirectory, 'broker-handoff.json');
  try { await fileIdentity(ticketPath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const ticket = JSON.parse(await fs.readFile(ticketPath, 'utf8'));
  const custodyPath = path.join(plan.ownerDirectory, 'ownership.json');
  await fileIdentity(custodyPath);
  const bytes = await fs.readFile(custodyPath), previous = JSON.parse(bytes);
  const runnerDigest = createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
  if (ticket.format !== 'code-ai-broker-handoff' || ticket.version !== 1
      || ticket.custodySha256 !== createHash('sha256').update(bytes).digest('hex')
      || ticket.brokerModuleSha256 !== plan.brokerModuleSha256 || ticket.runnerModuleSha256 !== runnerDigest
      || previous.format !== 'code-ai-native-owner-custody' || previous.version !== 2
      || previous.profileId !== plan.profileId || previous.codexHome !== await fs.realpath(plan.codexHome)
      || previous.backendSocket !== backendSocket || previous.frontendSocket !== plan.frontendSocket
      || previous.nativeBinarySha256 !== plan.nativeBinarySha256
      || previous.bootId !== (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      || !await isDead(previous.runnerPid, previous.runnerIdentity)) throw new Error('Native handoff unavailable');
  const backend = await endpointIdentity(backendSocket, true, previous.backend);
  if (!sameEndpoint(backend, previous.backend)) throw new Error('Native handoff endpoint changed');
  const identity = await proveNativeListener(plan, backend, previous.nativePid);
  if (JSON.stringify(identity) !== JSON.stringify(previous.nativeIdentity)) throw new Error('Native handoff generation changed');
  await initializedOwner(backendSocket, plan.codexHome);
  let front;
  try { front = await endpointIdentity(plan.frontendSocket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (front) {
    if (!sameEndpoint(front, previous.frontend) || await listenerLiveOrUncertain(plan.frontendSocket)
        || !sameEndpoint(await endpointIdentity(plan.frontendSocket), front)) throw new Error('Broker predecessor still live or changed');
    // Only the recorded, dead adapter socket; never the engine socket or lock file.
    await fs.unlink(plan.frontendSocket);
  }
  return { pid: previous.nativePid, identity, ticketPath };
}

async function recordCustody(plan, backendSocket, frontend, nativePid) {
  const backend = await endpointIdentity(backendSocket, true);
  const nativeIdentity = await proveNativeListener(plan, backend, nativePid);
  if (!sameEndpoint(await endpointIdentity(backendSocket, true), backend)) throw new Error('Native endpoint changed');
  const record = { format: 'code-ai-native-owner-custody', version: 2, profileId: plan.profileId,
    runnerPid: process.pid, nativePid, codexHome: await fs.realpath(plan.codexHome),
    runnerIdentity: await processIdentity(process.pid), nativeIdentity,
    bootId: (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    nativeBinarySha256: plan.nativeBinarySha256, brokerModuleSha256: plan.brokerModuleSha256,
    backendSocket, frontendSocket: plan.frontendSocket, backend,
    frontend: frontend ? await endpointIdentity(plan.frontendSocket) : null };
  const temporary = path.join(plan.ownerDirectory, `ownership-${process.pid}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, path.join(plan.ownerDirectory, 'ownership.json'));
}

async function pinnedProgram(filename, expected) {
  const data = await fs.readFile(filename);
  if (createHash('sha256').update(data).digest('hex') !== expected) throw new Error('Qualified program changed');
}

async function initializedOwner(socket, home) {
  const ws = new WebSocket(`ws+unix://${socket}:/`, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5_000 });
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('Owner unavailable'))); });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owner initialization timed out')), 5_000);
      ws.on('message', (bytes, binary) => {
        if (binary) return;
        let frame; try { frame = JSON.parse(bytes.toString()); } catch { return; }
        if (frame.id !== 1) return;
        clearTimeout(timer);
        if (frame.error) reject(new Error('Owner initialization rejected')); else resolve(frame.result);
      });
      ws.once('error', () => { clearTimeout(timer); reject(new Error('Owner disconnected')); });
      ws.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'code-ai-profile-owner-readiness', version: '1.0.0' } } }));
    });
    if (typeof result?.codexHome !== 'string'
        || await fs.realpath(result.codexHome) !== await fs.realpath(home)) throw new Error('Owner profile mismatch');
  } finally { ws.terminate(); }
}

const lockHeld = process.argv[2] === '--lock-held';
const planPath = process.argv[lockHeld ? 3 : 2]; let native, broker, readyPath, lockChild, stopping = false;
let adoption = null, adoptionReady = false, nativeWatch = null;
let complete;
const stopped = new Promise(resolve => { complete = resolve; });
async function stop(code) {
  if (stopping) return; stopping = true;
  if (nativeWatch) clearInterval(nativeWatch);
  if (readyPath) await fs.unlink(readyPath).catch(() => {});
  await Promise.resolve(broker?.close?.()).catch(() => {});
  if (native?.pid && native.exitCode === null && (!adoption || adoptionReady)) native.kill('SIGTERM');
  if (lockChild?.pid && lockChild.exitCode === null) lockChild.kill('SIGTERM');
  process.exitCode = code; complete();
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void stop(0); });

try {
  if (!planPath || !path.isAbsolute(planPath)) throw new Error('Explicit owner plan required');
  const plan = validateProfilePlan(JSON.parse(await fs.readFile(planPath, 'utf8')));
  await pinnedProgram(plan.nativeBinary, plan.nativeBinarySha256); await pinnedProgram(plan.brokerModule, plan.brokerModuleSha256);
  await privateDirectory(plan.ownerDirectory); await privateDirectory(path.dirname(plan.frontendSocket));
  const lockPath = path.join(plan.ownerDirectory, 'owner.lock');
  if (!lockHeld) {
    const fd = await fs.open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await fd.close(); await fileIdentity(lockPath);
    lockChild = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--no-fork', lockPath, process.execPath,
      fileURLToPath(import.meta.url), '--lock-held', planPath], { env: process.env, stdio: ['inherit', 'inherit', 'pipe'] });
    // Inner diagnostics remain fixed; normalize lock/inner failure to one message.
    lockChild.stderr.resume();
    const code = await new Promise((resolve, reject) => {
      lockChild.once('error', () => reject(new Error('Owner lock unavailable')));
      lockChild.once('exit', code => resolve(code ?? 1));
    });
    process.exitCode = code;
    if (code && !stopping) process.stderr.write('CODE_AI_NATIVE_OWNER_UNAVAILABLE\n');
  } else {
  await proveHeldLock(lockPath);
  const backendSocket = path.join(plan.ownerDirectory, 'engine.sock');
  adoption = await adoptRecordedNative(plan, backendSocket);
  if (adoption) {
    native = { pid: adoption.pid, exitCode: null, kill: signal => {
      void processIdentity(adoption.pid).then(identity => {
        if (identity.startTime === adoption.identity.startTime) process.kill(adoption.pid, signal);
      }).catch(() => {});
    } };
    nativeWatch = setInterval(() => {
      void processIdentity(adoption.pid).then(identity => {
        if (identity.startTime !== adoption.identity.startTime) void stop(1);
      }).catch(() => { void stop(1); });
    }, 1000);
    nativeWatch.unref();
  } else {
  await recoverRecordedSockets(plan, backendSocket);
  await requireAbsent(backendSocket); await requireAbsent(plan.frontendSocket);
  native = spawn(plan.nativeBinary, nativeOwnerArguments(plan), {
    env: { ...process.env, HOME: plan.userHome, CODEX_HOME: plan.codexHome, CODEX_CLI_PATH: plan.nativeBinary },
    cwd: plan.userHome, stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Native logs may contain account/config context; never copy them to journald/tool output.
  native.stderr.resume();
  native.once('error', () => { void stop(1); }); native.once('exit', () => { if (!stopping) void stop(1); });
  const deadline = Date.now() + 15_000;
  while (!stopping && !await fs.stat(backendSocket).then(entry => entry.isSocket(), () => false)) {
    if (Date.now() > deadline) throw new Error('Owner startup timed out');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (stopping) throw new Error('Owner stopped during startup');
  await initializedOwner(backendSocket, plan.codexHome);
  await recordCustody(plan, backendSocket, false, native.pid);
  }
  const module = await import(pathToFileURL(plan.brokerModule).href);
  broker = await module.startCodexSharedOwnerBroker({ socketPath: plan.frontendSocket, backendSocket,
    codexHome: plan.codexHome, journalPath: path.join(plan.ownerDirectory, 'broker-journal.json') });
  await initializedOwner(plan.frontendSocket, plan.codexHome);
  await recordCustody(plan, backendSocket, true, native.pid);
  readyPath = path.join(plan.ownerDirectory, 'ready.json');
  await fs.writeFile(readyPath, JSON.stringify({ format: 'code-ai-native-owner-readiness', version: 1,
    profileId: plan.profileId, nativePid: native.pid, profileVerified: true, unixOnly: true,
    nativeBinarySha256: plan.nativeBinarySha256, brokerModuleSha256: plan.brokerModuleSha256 }) + '\n', { mode: 0o600 });
  if (adoption) {
    await fs.unlink(adoption.ticketPath);
    adoptionReady = true;
  }
  process.stdout.write('CODE_AI_NATIVE_OWNER_READY\n'); await stopped;
  }
} catch {
  process.stderr.write('CODE_AI_NATIVE_OWNER_UNAVAILABLE\n'); await stop(1);
}
