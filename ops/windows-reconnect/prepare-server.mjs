#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WINDOWS_LINK_USER = 'codeai-windows';
export const WINDOWS_LINK_HOME = '/var/lib/code-ai-windows-link';
export const PC_CLIENT_KEY = '/root/.ssh/code-ai-personal-windows-20261008_ed25519';

export function runSafe(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 20000 });
  if (r.error || r.status !== 0) throw new Error(`${path.basename(command)} failed (${r.status ?? 'spawn'})`);
  return r.stdout;
}

export function prepareServer() {
  if (process.getuid() !== 0) throw new Error('Server preparation requires root');
  const existing = spawnSync('/usr/bin/getent', ['passwd', WINDOWS_LINK_USER], { encoding: 'utf8' });
  if (existing.status !== 0) runSafe('/usr/sbin/useradd', ['--create-home', '--home-dir', WINDOWS_LINK_HOME, '--shell', '/bin/bash', WINDOWS_LINK_USER]);
  const user = runSafe('/usr/bin/getent', ['passwd', WINDOWS_LINK_USER]).trim().split(':');
  if (Number(user[2]) === 0 || user[5] !== WINDOWS_LINK_HOME) throw new Error('Unexpected connection account');
  const directory = path.join(WINDOWS_LINK_HOME, '.ssh');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chownSync(directory, Number(user[2]), Number(user[3]));
  if (!fs.existsSync(PC_CLIENT_KEY)) runSafe('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'code-ai-windows-reconnect-20261008', '-f', PC_CLIENT_KEY]);
  fs.chmodSync(PC_CLIENT_KEY, 0o600);
  if (!fs.existsSync(PC_CLIENT_KEY + '.pub')) throw new Error('Controller public key is missing');
  return { account: WINDOWS_LINK_USER, home: WINDOWS_LINK_HOME, authorizedWindowsKeys: 0, sudoGranted: false, clientPrivateKeyTransferred: false, servicesRestarted: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(prepareServer())); }
  catch (e) { console.error(e.message); process.exitCode=1; }
}
