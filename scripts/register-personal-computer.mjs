#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_REGISTRY = path.join(APP_ROOT, '.code-ai', 'remote-hosts.json');
const SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const SAFE_SSH_TARGET = /^[a-zA-Z0-9_.:@-]+$/;

function printUsage() {
  console.log(`Usage:
  node scripts/register-personal-computer.mjs \\
    --id personal-laptop \\
    --label "המחשב האישי" \\
    --control-target user@code-ai.example.com \\
    --reverse-port 44001

Options:
  --id ID                   Stable id used by the server selector
  --label LABEL             Human-readable label
  --control-target TARGET   SSH target reachable from the personal computer
  --reverse-port PORT       Loopback port allocated on the control plane
  --sidecar-port PORT       Loopback port on the personal computer (default: 4010)
  --ssh-reverse-port PORT   Optional loopback port for inbound SSH to the computer
  --ssh-local-port PORT     Local OpenSSH port on the computer (default: 22)
  --registry PATH           Private control-plane registry
  --pairing-file PATH       Owner-only pairing file to transfer to the computer
  --description TEXT        Optional UI description
  --help,-h                 Show help
`);
}

function readPort(value, name) {
  const port = Number(String(value ?? '').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

function readArgs(argv) {
  const options = {
    id: '',
    label: '',
    controlTarget: '',
    reversePort: 0,
    sidecarPort: 4010,
    sshReversePort: 0,
    sshLocalPort: 22,
    registry: DEFAULT_REGISTRY,
    pairingFile: '',
    description: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (typeof next !== 'string') throw new Error(`Missing value for ${argument}`);
      index += 1;
      return next;
    };
    switch (argument) {
      case '--id': options.id = value().trim().toLowerCase(); break;
      case '--label': options.label = value().trim(); break;
      case '--control-target': options.controlTarget = value().trim(); break;
      case '--reverse-port': options.reversePort = readPort(value(), '--reverse-port'); break;
      case '--sidecar-port': options.sidecarPort = readPort(value(), '--sidecar-port'); break;
      case '--ssh-reverse-port': options.sshReversePort = readPort(value(), '--ssh-reverse-port'); break;
      case '--ssh-local-port': options.sshLocalPort = readPort(value(), '--ssh-local-port'); break;
      case '--registry': options.registry = path.resolve(value()); break;
      case '--pairing-file': options.pairingFile = path.resolve(value()); break;
      case '--description': options.description = value().trim(); break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!SAFE_ID.test(options.id) || options.id === 'local') {
    throw new Error('--id must be a safe lowercase id and cannot be "local"');
  }
  if (!options.label) throw new Error('--label is required');
  if (!SAFE_SSH_TARGET.test(options.controlTarget)) {
    throw new Error('--control-target must be an OpenSSH host, alias, or user@host');
  }
  if (!options.reversePort) throw new Error('--reverse-port is required');
  if (options.sshReversePort && options.sshReversePort === options.reversePort) {
    throw new Error('--ssh-reverse-port must differ from --reverse-port');
  }
  options.pairingFile ||= path.join(APP_ROOT, '.code-ai', 'pairings', `${options.id}.env`);
  return options;
}

async function loadRegistry(registryPath) {
  if (!existsSync(registryPath)) {
    return { version: 1, hosts: [] };
  }
  const parsed = JSON.parse(await readFile(registryPath, 'utf8'));
  if (parsed?.version !== 1 || !Array.isArray(parsed.hosts)) {
    throw new Error(`Registry ${registryPath} is not a version 1 remote-host registry`);
  }
  return parsed;
}

async function writePrivateFile(targetPath, content) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, 0o600);
}

function envLine(name, value) {
  const normalized = String(value);
  if (/[\r\n\0]/.test(normalized)) {
    throw new Error(`${name} contains an unsupported control character`);
  }
  return `${name}=${normalized}`;
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const registry = await loadRegistry(options.registry);
  const existing = registry.hosts.find((host) => host.id === options.id);
  const requestedPorts = new Set([
    options.reversePort,
    options.sshReversePort || null,
  ].filter((port) => port !== null));
  const conflictingPort = registry.hosts.find((host) => {
    if (host.id === options.id || host.transport !== 'reverse-tunnel') {
      return false;
    }
    const occupiedPorts = [
      Number(host.localPort),
      Number(host.sshReversePort),
    ].filter(Number.isInteger);
    return occupiedPorts.some((port) => requestedPorts.has(port));
  });
  if (conflictingPort) {
    throw new Error(`A requested reverse port is already assigned to ${conflictingPort.id}`);
  }

  const token = typeof existing?.token === 'string' && existing.token.length >= 24
    ? existing.token
    : randomBytes(32).toString('hex');
  const nextHost = {
    id: options.id,
    label: options.label,
    transport: 'reverse-tunnel',
    enabled: true,
    token,
    localHost: '127.0.0.1',
    localPort: options.reversePort,
    ...(options.sshReversePort
      ? {
        sshReversePort: options.sshReversePort,
        sshLocalPort: options.sshLocalPort,
      }
      : {}),
    description: options.description || 'Personal Codex computer through a private reverse SSH tunnel',
  };
  const nextRegistry = {
    version: 1,
    hosts: [
      ...registry.hosts.filter((host) => host.id !== options.id),
      nextHost,
    ],
  };
  const pairingContent = [
    envLine('CODEX_REMOTE_HOST_ID', options.id),
    envLine('CODEX_REMOTE_HOST_LABEL', options.label),
    envLine('CODEX_REMOTE_AGENT_TOKEN', token),
    envLine('CODEX_REMOTE_CONTROL_TARGET', options.controlTarget),
    envLine('CODEX_REMOTE_REVERSE_PORT', options.reversePort),
    envLine('CODEX_REMOTE_SIDECAR_PORT', options.sidecarPort),
    ...(options.sshReversePort
      ? [
        envLine('CODEX_REMOTE_SSH_REVERSE_PORT', options.sshReversePort),
        envLine('CODEX_REMOTE_SSH_LOCAL_PORT', options.sshLocalPort),
      ]
      : []),
    '',
  ].join('\n');

  await writePrivateFile(options.registry, `${JSON.stringify(nextRegistry, null, 2)}\n`);
  await writePrivateFile(options.pairingFile, pairingContent);

  console.log(`Personal computer registered: ${options.label} (${options.id})`);
  console.log(`Registry updated: ${options.registry}`);
  console.log(`Pairing file created with mode 0600: ${options.pairingFile}`);
  console.log('Transfer the pairing file securely to the personal computer; its token was not printed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
