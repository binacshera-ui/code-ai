#!/usr/bin/env node
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_REGISTRY = path.join(APP_ROOT, '.code-ai', 'remote-hosts.json');
const SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const SAFE_SSH_TARGET = /^[a-zA-Z0-9_.:@-]+$/;
const SAFE_REMOTE_PATH = /^\/[a-zA-Z0-9_./-]+$/;
const REMOTE_RUNTIME_ASSETS = [
  'server/browser-mode',
  'server/design-mode',
  'server/personal-chrome',
  'server/ux-mode',
  'skills/gemini-design-partner',
  'skills/gemini-ux-partner',
];

function printUsage() {
  console.log(`Usage:
  node scripts/remote-host-deploy.mjs \\
    --id build-server \\
    --label "Build server" \\
    --ssh-target build-server \\
    --profiles-json '[{"id":"build-codex","label":"Build Codex","provider":"codex","codexHome":"/home/operator/.codex","workspaceCwd":"/srv/projects","defaultProfile":true}]'

Options:
  --id ID                 Stable server id used by the UI
  --label LABEL           Human-readable server label
  --ssh-target TARGET     OpenSSH host/alias reachable from this control plane
  --remote-port PORT      Loopback sidecar port on the remote host (default: 4010)
  --remote-dir PATH       Remote application directory (default: /opt/code-ai-remote/<id>)
  --storage-root PATH     Remote app storage (default: /var/lib/code-ai-remote/<id>)
  --profiles-json JSON    Provider profiles that exist on the remote host
  --registry PATH         Local private registry file (default: .code-ai/remote-hosts.json)
  --description TEXT      Optional UI description
  --skip-build            Reuse the existing local dist/
  --skip-start            Install files and registry but do not start/restart the remote sidecar
  --help,-h               Show help
`);
}

function readArgs(argv) {
  const options = {
    id: '',
    label: '',
    sshTarget: '',
    remotePort: 4010,
    remoteDir: '',
    storageRoot: '',
    profilesJson: '',
    registry: DEFAULT_REGISTRY,
    description: '',
    skipBuild: false,
    skipStart: false,
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
      case '--ssh-target': options.sshTarget = value().trim(); break;
      case '--remote-port': options.remotePort = Number.parseInt(value(), 10); break;
      case '--remote-dir': options.remoteDir = value().trim(); break;
      case '--storage-root': options.storageRoot = value().trim(); break;
      case '--profiles-json': options.profilesJson = value().trim(); break;
      case '--registry': options.registry = path.resolve(value()); break;
      case '--description': options.description = value().trim(); break;
      case '--skip-build': options.skipBuild = true; break;
      case '--skip-start': options.skipStart = true; break;
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
  if (!SAFE_SSH_TARGET.test(options.sshTarget)) throw new Error('--ssh-target is invalid');
  if (!Number.isInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65_535) {
    throw new Error('--remote-port must be a valid TCP port');
  }
  options.remoteDir ||= `/opt/code-ai-remote/${options.id}`;
  options.storageRoot ||= `/var/lib/code-ai-remote/${options.id}`;
  if (!SAFE_REMOTE_PATH.test(options.remoteDir) || !SAFE_REMOTE_PATH.test(options.storageRoot)) {
    throw new Error('Remote paths must be absolute and contain only safe path characters');
  }
  const profiles = JSON.parse(options.profilesJson);
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error('--profiles-json must contain a non-empty JSON array');
  }
  options.profilesJson = JSON.stringify(profiles);
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || APP_ROOT,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    encoding: 'utf8',
    stdio: options.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(' ')}`);
  }
}

function runCaptured(command, args) {
  const result = spawnSync(command, args, {
    cwd: APP_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return String(result.stdout || '').trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function envLine(name, value) {
  const normalized = String(value);
  if (/[\r\n\0]/.test(normalized)) {
    throw new Error(`Environment value ${name} contains an unsupported control character`);
  }
  return `${name}=${normalized}`;
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

async function saveRegistry(registryPath, registry) {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, registryPath);
  await chmod(registryPath, 0o600);
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const registry = await loadRegistry(options.registry);
  const previous = registry.hosts.find((host) => host.id === options.id);
  const token = typeof previous?.token === 'string' && previous.token.length >= 24
    ? previous.token
    : randomBytes(32).toString('hex');
  const sessionSecret = randomBytes(32).toString('hex');
  const serviceName = `code-ai-remote-${options.id}.service`;
  const remoteEnvPath = `${options.remoteDir}/.remote-agent.env`;

  runCaptured('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    options.sshTarget,
    'true',
  ]);

  if (!options.skipBuild) {
    run('npm', ['run', 'build']);
  }
  if (!existsSync(path.join(APP_ROOT, 'dist', 'server.js'))) {
    throw new Error('dist/server.js does not exist; run npm run build first');
  }

  run('ssh', [
    options.sshTarget,
    `install -d -m 755 ${shellQuote(options.remoteDir)} ${shellQuote(options.storageRoot)}`,
  ]);
  run('rsync', [
    '-az',
    '--delete',
    `${path.join(APP_ROOT, 'dist')}/`,
    `${options.sshTarget}:${options.remoteDir}/dist/`,
  ]);
  for (const relativePath of REMOTE_RUNTIME_ASSETS) {
    const sourcePath = path.join(APP_ROOT, relativePath);
    if (!existsSync(sourcePath)) {
      throw new Error(`Required remote runtime asset is missing: ${relativePath}`);
    }
    const remotePath = `${options.remoteDir}/${relativePath}`;
    run('ssh', [
      options.sshTarget,
      `install -d -m 755 ${shellQuote(remotePath)}`,
    ]);
    run('rsync', [
      '-az',
      '--delete',
      `${sourcePath}/`,
      `${options.sshTarget}:${remotePath}/`,
    ]);
  }
  run('rsync', [
    '-az',
    path.join(APP_ROOT, 'package.json'),
    path.join(APP_ROOT, 'package-lock.json'),
    `${options.sshTarget}:${options.remoteDir}/`,
  ]);
  run('ssh', [
    options.sshTarget,
    `cd ${shellQuote(options.remoteDir)} && npm ci --omit=dev`,
  ]);

  const envContent = [
    envLine('NODE_ENV', 'production'),
    envLine('HOST', '127.0.0.1'),
    envLine('PORT', options.remotePort),
    envLine('CODEX_APP_ROOT', options.remoteDir),
    envLine('CODEX_STORAGE_ROOT', options.storageRoot),
    envLine('CODEX_UPLOAD_ROOT', `${options.storageRoot}/uploads`),
    envLine('CODEX_QUEUE_ROOT', `${options.storageRoot}/queue`),
    envLine('CODEX_LOG_ROOT', `${options.storageRoot}/logs`),
    envLine('CODEX_OPEN_ACCESS', 'true'),
    envLine('CODEX_ALLOW_ANY_PATHS', 'true'),
    envLine('CODEX_PROFILES_JSON_BASE64', Buffer.from(options.profilesJson, 'utf8').toString('base64')),
    envLine('CODEX_BIN', '/usr/local/bin/codex'),
    envLine('CODEX_REMOTE_AGENT_TOKEN', token),
    envLine('SESSION_SECRET', sessionSecret),
    '',
  ].join('\n');
  run('ssh', [
    options.sshTarget,
    `umask 077; tee ${shellQuote(remoteEnvPath)} >/dev/null; chmod 600 ${shellQuote(remoteEnvPath)}`,
  ], { input: envContent });

  const unitContent = `[Unit]
Description=code-ai remote agent (${options.id})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${options.remoteDir}
ExecStart=/usr/bin/env node --env-file=${remoteEnvPath} ${options.remoteDir}/dist/server.js
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
  run('ssh', [
    options.sshTarget,
    `umask 077; tee ${shellQuote(`/etc/systemd/system/${serviceName}`)} >/dev/null; chmod 644 ${shellQuote(`/etc/systemd/system/${serviceName}`)}`,
  ], { input: unitContent });

  if (!options.skipStart) {
    run('ssh', [
      options.sshTarget,
      `systemctl daemon-reload && systemctl enable ${shellQuote(serviceName)} && systemctl restart ${shellQuote(serviceName)} && systemctl is-active ${shellQuote(serviceName)}`,
    ]);
  }

  const nextHost = {
    id: options.id,
    label: options.label,
    transport: 'ssh',
    enabled: true,
    token,
    sshTarget: options.sshTarget,
    remotePort: options.remotePort,
    description: options.description || `Remote code-ai runtime via ${options.sshTarget}`,
  };
  registry.hosts = [
    ...registry.hosts.filter((host) => host.id !== options.id),
    nextHost,
  ];
  await saveRegistry(options.registry, registry);

  console.log(`Remote host installed: ${options.label} (${options.id})`);
  console.log(`Registry updated: ${options.registry}`);
  console.log(`Remote service: ${serviceName}${options.skipStart ? ' (not started)' : ' (active)'}`);
  console.log('The remote token was written only to owner-readable runtime files and was not printed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
