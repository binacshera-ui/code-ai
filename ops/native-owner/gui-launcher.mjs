/** Next-launch GUI opt-in only. Existing desktop instances are never stopped. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateProfilePlan } from './profile-artifacts.mjs';

try {
  const [planPath, ...originalArgs] = process.argv.slice(2);
  if (!planPath || !path.isAbsolute(planPath)) throw new Error('Explicit profile plan required');
  const plan = validateProfilePlan(JSON.parse(await fs.readFile(planPath, 'utf8')));
  const readyPath = path.join(plan.ownerDirectory, 'ready.json');
  const readyEntry = await fs.lstat(readyPath);
  if (!readyEntry.isFile() || readyEntry.uid !== process.getuid() || (readyEntry.mode & 0o077) !== 0) throw new Error('Owner not ready');
  const ready = JSON.parse(await fs.readFile(readyPath, 'utf8'));
  if (ready.profileId !== plan.profileId || ready.profileVerified !== true
      || ready.nativeBinarySha256 !== plan.nativeBinarySha256 || ready.brokerModuleSha256 !== plan.brokerModuleSha256) throw new Error('Owner version mismatch');
  const child = spawn(plan.desktopExecutable, originalArgs, {
    env: { ...process.env, HOME: plan.userHome, CODEX_HOME: plan.codexHome,
      PATH: `${path.dirname(plan.nodeBinary)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      CODEX_CLI_PATH: plan.dispatcherModule, CODE_AI_CODEX_NATIVE_BIN: plan.nativeBinary,
      CODE_AI_CODEX_SHARED_SOCKET: plan.frontendSocket, CODE_AI_CODEX_SHARED_STDIO: plan.adapterModule },
    stdio: 'ignore', detached: true,
  });
  child.once('error', () => { process.stderr.write('CODE_AI_NATIVE_GUI_LAUNCH_UNAVAILABLE\n'); process.exitCode = 1; });
  child.unref();
} catch {
  process.stderr.write('CODE_AI_NATIVE_GUI_LAUNCH_UNAVAILABLE\n'); process.exitCode = 1;
}
