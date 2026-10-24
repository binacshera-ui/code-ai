/** Read-only native program metadata. No credentials, settings, history or raw environment output. */
import { readFile, realpath, stat, access, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

try {
const [runtimePidText, environmentFile, desktopFile, publicProfilesJson] = process.argv.slice(2);
if (!/^[1-9][0-9]*$/.test(runtimePidText || '')) throw new Error('Explicit runtime PID required');
const environment = Object.fromEntries((await readFile(`/proc/${runtimePidText}/environ`))
  .toString().split('\0').filter(Boolean).map(field => {
    const i = field.indexOf('='); return [field.slice(0, i), field.slice(i + 1)];
  }));
if (environmentFile && environmentFile !== '-') {
  if (!path.isAbsolute(environmentFile)) throw new Error('Explicit environment file required');
  const { parseEnv } = await import('node:util');
  Object.assign(environment, parseEnv(await readFile(environmentFile, 'utf8')));
}
const processStatus = await readFile(`/proc/${runtimePidText}/status`, 'utf8');
const runtimeUid = Number(/^Uid:\s+([0-9]+)/m.exec(processStatus)?.[1]);
const runtimeGid = Number(/^Gid:\s+([0-9]+)/m.exec(processStatus)?.[1]);
let profiles;
if (publicProfilesJson) profiles = JSON.parse(publicProfilesJson);
else if (environment.CODEX_PROFILES_JSON_BASE64) profiles = JSON.parse(Buffer.from(environment.CODEX_PROFILES_JSON_BASE64, 'base64').toString());
else if (environment.CODEX_PROFILES_JSON) profiles = JSON.parse(environment.CODEX_PROFILES_JSON);
else profiles = [{ id: 'developer', provider: 'codex', codexHome: '/home/developer/.codex' },
  { id: 'developer2', provider: 'codex', codexHome: '/home/developer2/.codex' }];
if (!Array.isArray(profiles)) throw new Error('Public profiles must be an array');
const allowedHomes = new Set();
for (const profile of profiles) {
  if (profile.provider !== 'codex') continue;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(profile.id) || !path.isAbsolute(profile.codexHome || '')) throw new Error('Public profile identity invalid');
  allowedHomes.add(profile.codexHome);
}
const executableMetadata = async filename => {
  const filenameReal = await realpath(filename);
  const content = await readFile(filenameReal);
  const info = await stat(filenameReal);
  return { path: filenameReal, sha256: createHash('sha256').update(content).digest('hex'),
    elf: content.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), uid: info.uid, gid: info.gid };
};
const commandPath = async command => {
  if (path.isAbsolute(command)) return realpath(command);
  if (!/^[A-Za-z0-9._-]+$/.test(command)) throw new Error('Executable command identity invalid');
  for (const directory of (environment.PATH || '').split(':').filter(path.isAbsolute)) {
    const candidate = path.join(directory, command);
    try { await access(candidate); return await realpath(candidate); } catch { /* No public candidate here. */ }
  }
  return null;
};
const nativePrograms = new Set();
const nativeProcesses = [];
for (const entry of await readdir('/proc')) {
  if (!/^[0-9]+$/.test(entry)) continue;
  try {
    const executable = await realpath(`/proc/${entry}/exe`);
    if (!executable.endsWith('/codex')) continue;
    const status = await readFile(`/proc/${entry}/status`, 'utf8');
    const args = (await readFile(`/proc/${entry}/cmdline`)).toString().split('\0').filter(Boolean);
    const env = Object.fromEntries((await readFile(`/proc/${entry}/environ`)).toString()
      .split('\0').filter(Boolean).map(field => { const i = field.indexOf('='); return [field.slice(0, i), field.slice(i + 1)]; }));
    const home = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, '.codex') : null);
    if (!allowedHomes.has(home)) continue;
    nativePrograms.add(executable);
    nativeProcesses.push({ pid: Number(entry), parentPid: Number(/^PPid:\s+([0-9]+)/m.exec(status)?.[1]),
      uid: Number(/^Uid:\s+([0-9]+)/m.exec(status)?.[1]), gid: Number(/^Gid:\s+([0-9]+)/m.exec(status)?.[1]),
      executable, codexHome: home, appServer: args.includes('app-server'),
      configOverrideCount: args.filter(arg => arg === '-c' || arg === '--config').length });
  } catch { /* Processes may exit. No diagnostic bodies are emitted. */ }
}
const configuredCommand = environment.CODEX_BIN || 'codex';
const configuredCommandPath = await commandPath(configuredCommand);
const qualifiedCandidates = new Set();
if (configuredCommandPath) {
  const metadata = await executableMetadata(configuredCommandPath);
  if (metadata.elf) qualifiedCandidates.add(metadata.path);
  else {
    const packageRoot = path.resolve(path.dirname(configuredCommandPath), '..');
    for (const suffix of [
      'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
      'vendor/x86_64-unknown-linux-musl/bin/codex',
      'vendor/x86_64-unknown-linux-musl/codex/codex',
    ]) {
      const candidate = path.join(packageRoot, suffix);
      try { const info = await executableMetadata(candidate); if (info.elf) qualifiedCandidates.add(info.path); } catch { /* Not this packaging layout. */ }
    }
  }
}
for (const filename of qualifiedCandidates) nativePrograms.add(filename);
const programs = [];
for (const filename of nativePrograms) {
  const metadata = await executableMetadata(filename);
  const result = spawnSync(filename, ['--version'], { env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
  const version = /^codex-cli ([0-9A-Za-z.+-]+)\s*$/m.exec(result.stdout || '')?.[1] || null;
  programs.push({ ...metadata, version, versionCommandSuccessful: result.status === 0 && version !== null,
    configuredProgramCandidate: qualifiedCandidates.has(filename) });
}
const profileMetadata = [];
for (const profile of profiles) {
  if (profile.provider !== 'codex') continue;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(profile.id) || !path.isAbsolute(profile.codexHome || '')) throw new Error('Public profile identity invalid');
  const codexHome = await realpath(profile.codexHome);
  const info = await stat(codexHome);
  const rootRuntimePolicy = environment.CODE_AI_PROFILE_RUNTIME_USER === 'root';
  profileMetadata.push({ id: profile.id, codexHome, userHome: path.dirname(codexHome),
    directoryUid: info.uid, directoryGid: info.gid,
    effectiveRuntimeUid: rootRuntimePolicy ? 0 : runtimeUid === 0 ? info.uid : runtimeUid,
    effectiveRuntimeGid: rootRuntimePolicy ? 0 : runtimeUid === 0 ? info.gid : runtimeGid,
    rootRuntimePolicy, originalDesktopExec: null,
    frontendSocket: path.join(codexHome, 'code-ai-shared-owner', 'owner.sock') });
}
if (desktopFile && desktopFile !== '-') {
  if (!path.isAbsolute(desktopFile)) throw new Error('Explicit desktop source required');
  const text = await readFile(desktopFile, 'utf8');
  const desktopExec = /^Exec=(.*)$/m.exec(text)?.[1] || null;
  if (desktopExec && !/^[\w\s./%"'=-]+$/.test(desktopExec)) throw new Error('Desktop program identity contains unsupported characters');
  for (const profile of profileMetadata) profile.originalDesktopExec = desktopExec;
}
console.log(JSON.stringify({ format: 'code-ai-native-program-public-census', version: 1,
  observedAt: new Date().toISOString(), runtimePid: Number(runtimePidText), runtimeUid, runtimeGid,
  node: await executableMetadata(`/proc/${runtimePidText}/exe`),
  configuredCommand, configuredCommandPath, profiles: profileMetadata,
  nativePrograms: programs, nativeProcesses, credentialsPrinted: false }));
} catch {
  // Parsing failures must not reveal a malformed environment/profile body.
  process.stderr.write('CODE_AI_NATIVE_PROGRAM_CENSUS_UNAVAILABLE\n');
  process.exitCode = 1;
}
