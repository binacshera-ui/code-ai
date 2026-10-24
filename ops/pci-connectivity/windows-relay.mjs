#!/usr/bin/env node
// This file runs as a forced SSH command. It never evaluates a local shell.
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function relayArguments(command) {
  if (typeof command !== 'string' || command.length > 65536 || command.includes('\0')) throw new Error('Invalid remote command');
  return ['-T', '-F', '/root/.ssh/config', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '--', 'personal-windows-ssh', ...(command ? [command] : [])];
}

async function available() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 44022 });
    let settled = false;
    const finish = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = relayArguments(process.env.SSH_ORIGINAL_COMMAND || '');
    if (!await available()) {
      process.stderr.write('Personal Windows SSH tunnel is offline (central loopback 44022); no remote command ran.\n');
      process.exitCode = 69;
    } else {
      const child = spawn('/usr/bin/ssh', args, { stdio: 'inherit', shell: false, env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8' } });
      child.once('error', () => { process.stderr.write('Unable to start Windows SSH relay.\n'); process.exitCode = 70; });
      child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 70); });
      process.once('SIGTERM', () => child.kill('SIGTERM'));
      process.once('SIGINT', () => child.kill('SIGINT'));
    }
  } catch {
    process.stderr.write('Invalid Windows relay request.\n');
    process.exitCode = 64;
  }
}
