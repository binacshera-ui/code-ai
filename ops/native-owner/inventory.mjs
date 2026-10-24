/** Read-only public identity census. Never emits environments, config or history. */
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

const [pidText, environmentFile] = process.argv.slice(2);
if (!/^[1-9][0-9]*$/.test(pidText || '')) throw new Error('Explicit runtime PID required');
const readEnvironment = async pid => Object.fromEntries((await readFile(`/proc/${pid}/environ`))
  .toString().split('\0').filter(Boolean).map(field => {
    const i = field.indexOf('='); return [field.slice(0, i), field.slice(i + 1)];
  }));
const env = await readEnvironment(pidText);
if (environmentFile) {
  if (!path.isAbsolute(environmentFile)) throw new Error('Explicit environment source required');
  Object.assign(env, parseEnv(await readFile(environmentFile, 'utf8')));
}
let profiles;
if (env.CODEX_PROFILES_JSON_BASE64) profiles = JSON.parse(Buffer.from(env.CODEX_PROFILES_JSON_BASE64, 'base64').toString());
else if (env.CODEX_PROFILES_JSON) profiles = JSON.parse(env.CODEX_PROFILES_JSON);
else profiles = [{ id: 'developer', provider: 'codex', codexHome: '/home/developer/.codex', workspaceCwd: '/root/projects/code-ai' },
  { id: 'developer2', provider: 'codex', codexHome: '/home/developer2/.codex', workspaceCwd: '/root/projects/code-ai' }];
if (!Array.isArray(profiles)) throw new Error('Profile identity configuration invalid');
const result = [];
for (const profile of profiles) {
  if (profile.provider !== 'codex') continue;
  if (typeof profile.id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(profile.id)
      || typeof profile.codexHome !== 'string' || !path.isAbsolute(profile.codexHome)) throw new Error('Profile identity invalid');
  const home = await realpath(profile.codexHome);
  const info = await stat(home);
  result.push({ id: profile.id, codexHome: home, workspaceCwd: profile.workspaceCwd,
    uid: info.uid, gid: info.gid, homeMode: (info.mode & 0o777).toString(8), nativeProcesses: [] });
}
for (const entry of await readdir('/proc')) {
  if (!/^[0-9]+$/.test(entry)) continue;
  try {
    const exe = await realpath(`/proc/${entry}/exe`);
    if (!/codex(?:$|[-_/])/.test(exe) || exe.endsWith('/node')) continue;
    const args = (await readFile(`/proc/${entry}/cmdline`)).toString().split('\0').filter(Boolean);
    const processEnv = await readEnvironment(entry);
    const home = processEnv.CODEX_HOME || (processEnv.HOME ? path.join(processEnv.HOME, '.codex') : null);
    const profile = result.find(profile => profile.codexHome === home);
    if (!profile) continue;
    const status = await readFile(`/proc/${entry}/status`, 'utf8');
    profile.nativeProcesses.push({ pid: Number(entry), executable: exe,
      uid: Number(/^Uid:\s+([0-9]+)/m.exec(status)?.[1]),
      parentPid: Number(/^PPid:\s+([0-9]+)/m.exec(status)?.[1]),
      appServer: args.includes('app-server'), stdio: !args.includes('--listen') || args.includes('stdio://'),
      configOverrideCount: args.filter(arg => arg === '-c' || arg === '--config').length });
  } catch { /* Process exited; no private diagnostic body is retained. */ }
}
console.log(JSON.stringify({ format: 'code-ai-native-owner-public-inventory', version: 1,
  observedAt: new Date().toISOString(), runtimePid: Number(pidText),
  runtimeUserRootPolicy: env.CODE_AI_PROFILE_RUNTIME_USER === 'root',
  sharedProfiles: (env.CODE_AI_CODEX_SHARED_OWNER_PROFILES || '').split(',').filter(Boolean),
  profiles: result, credentialsPrinted: false }));
