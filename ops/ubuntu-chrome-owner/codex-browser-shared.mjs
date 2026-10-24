#!/home/refael/.local/lib/node-v24.21.0-linux-x64/bin/node
/** Official browser host CLI entry: reuse the installed shared-owner dispatcher. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

try {
  if (os.hostname() !== 'gpu-lab' || process.getuid() !== 1000) throw Error('identity');
  const planFile = '/home/refael/code-ai-native-owner/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json';
  const stat = await fs.lstat(planFile);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('plan');
  const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
  if (plan.profileId !== 'ubuntu-refael' || plan.codexHome !== '/home/refael/.codex'
      || plan.frontendSocket !== '/home/refael/.codex/code-ai-shared-owner/owner.sock') throw Error('profile');
  const { dispatchNativeCli } = await import(pathToFileURL(plan.dispatcherModule).href);
  await dispatchNativeCli(process.argv.slice(2), {
    ...process.env,
    CODEX_HOME: plan.codexHome,
    CODEX_CLI_PATH: process.argv[1],
    CODE_AI_CODEX_NATIVE_BIN: plan.nativeBinary,
    CODE_AI_CODEX_SHARED_SOCKET: plan.frontendSocket,
    CODE_AI_CODEX_SHARED_STDIO: plan.adapterModule,
    PATH: path.dirname(plan.nodeBinary) + ':' + (process.env.PATH || '/usr/bin:/bin'),
  });
} catch {
  process.stderr.write('CODE_AI_BROWSER_SHARED_OWNER_UNAVAILABLE\n');
  process.exitCode = 1;
}
