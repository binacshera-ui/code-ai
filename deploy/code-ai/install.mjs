#!/usr/bin/env node
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '../..');
const IS_WINDOWS = process.platform === 'win32';
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || APP_ROOT;

function getDefaultCodexBin() {
  return IS_WINDOWS ? 'codex.cmd' : 'codex';
}

function getCommandName(command) {
  if (!IS_WINDOWS) {
    return command;
  }

  if (path.extname(command) || command.includes(path.sep)) {
    return command;
  }

  return `${command}.cmd`;
}

function printUsage() {
  console.log(`Usage: node deploy/code-ai/install.mjs [options]

Options:
  --app-name NAME            Process name (default: code-ai-app)
  --port PORT                Service port (default: 4000)
  --codex-home PATH          Codex home for the default profile
  --workspace PATH           Workspace directory for the default profile
  --profile-id ID            Default profile id (default: default)
  --profile-label LABEL      Default profile label (default: Default)
  --profiles-json JSON       Full profiles JSON array, overrides single-profile flags
  --storage-root PATH        Storage root for uploads, queue, and logs
  --public-hosts CSV         Optional explicit public hosts
  --open-access BOOL         true/false (default: true)
  --allow-any-paths BOOL     true/false for absolute path access (default: true)
  --extra-readable-roots CSV Extra relative-file search roots
  --database-url URL         Optional Postgres URL
  --session-secret VALUE     Session secret
  --cookie-domain VALUE      Optional cookie domain
  --device-password VALUE    Device unlock password
  --codex-bin PATH           Codex CLI binary/path
  --skip-npm-install         Skip npm install
  --skip-build               Skip npm run build
  --skip-pm2                 Skip PM2 start/restart
  --help, -h                 Show this help
`);
}

function parseArgs(argv) {
  const defaults = {
    appName: process.env.PM2_APP_NAME || 'code-ai-app',
    port: process.env.PORT || '4000',
    codexHome: process.env.CODEX_HOME_PATH || path.join(HOME_DIR, '.codex'),
    workspace: process.env.WORKSPACE_PATH || APP_ROOT,
    profileId: process.env.PROFILE_ID || 'default',
    profileLabel: process.env.PROFILE_LABEL || 'Default',
    profilesJson: process.env.CODEX_PROFILES_JSON || '',
    storageRoot: process.env.CODEX_STORAGE_ROOT || path.join(APP_ROOT, '.code-ai'),
    publicHosts: process.env.CODEX_PUBLIC_HOSTS || '',
    openAccess: process.env.CODEX_OPEN_ACCESS || 'true',
    allowAnyPaths: process.env.CODEX_ALLOW_ANY_PATHS || 'true',
    extraReadableRoots: process.env.CODEX_ALLOWED_FILE_ROOTS || '',
    databaseUrl: process.env.DATABASE_URL || '',
    sessionSecret: process.env.SESSION_SECRET || 'code-ai-session-secret',
    cookieDomain: process.env.SESSION_COOKIE_DOMAIN || '',
    devicePassword: process.env.CODEX_DEVICE_ADMIN_PASSWORD || '403005Ashim@',
    codexBin: process.env.CODEX_BIN || getDefaultCodexBin(),
    skipNpmInstall: false,
    skipBuild: false,
    skipPm2: false,
  };

  const options = { ...defaults };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    const readValue = () => {
      const value = argv[index + 1];
      if (typeof value !== 'string') {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--app-name':
        options.appName = readValue();
        break;
      case '--port':
        options.port = readValue();
        break;
      case '--codex-home':
        options.codexHome = readValue();
        break;
      case '--workspace':
        options.workspace = readValue();
        break;
      case '--profile-id':
        options.profileId = readValue();
        break;
      case '--profile-label':
        options.profileLabel = readValue();
        break;
      case '--profiles-json':
        options.profilesJson = readValue();
        break;
      case '--storage-root':
        options.storageRoot = readValue();
        break;
      case '--public-hosts':
        options.publicHosts = readValue();
        break;
      case '--open-access':
        options.openAccess = readValue();
        break;
      case '--allow-any-paths':
        options.allowAnyPaths = readValue();
        break;
      case '--extra-readable-roots':
        options.extraReadableRoots = readValue();
        break;
      case '--database-url':
        options.databaseUrl = readValue();
        break;
      case '--session-secret':
        options.sessionSecret = readValue();
        break;
      case '--cookie-domain':
        options.cookieDomain = readValue();
        break;
      case '--device-password':
        options.devicePassword = readValue();
        break;
      case '--codex-bin':
        options.codexBin = readValue();
        break;
      case '--skip-npm-install':
        options.skipNpmInstall = true;
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '--skip-pm2':
        options.skipPm2 = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || APP_ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const details = options.capture
      ? `${result.stdout || ''}${result.stderr || ''}`.trim()
      : '';
    throw new Error(`Command failed: ${command} ${args.join(' ')}${details ? `\n${details}` : ''}`);
  }

  return result;
}

function commandExists(command, versionArgs = ['--version']) {
  const result = spawnSync(command, versionArgs, {
    stdio: 'ignore',
    shell: false,
  });

  return !result.error && result.status === 0;
}

function parseProfilesJson(rawValue) {
  const parsed = JSON.parse(rawValue);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('CODEX_PROFILES_JSON must be a non-empty JSON array');
  }
  return JSON.stringify(parsed);
}

async function loadExistingEnv(envFilePath) {
  if (!existsSync(envFilePath)) {
    return new Map();
  }

  const content = await readFile(envFilePath, 'utf8');
  const entries = new Map();

  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#') || !line.includes('=')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    if (key) {
      entries.set(key, value);
    }
  }

  return entries;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nodeCommand = process.execPath;
  const npmCommand = getCommandName('npm');
  const npxCommand = getCommandName('npx');
  const codexCommand = options.codexBin;

  if (!commandExists(nodeCommand)) {
    throw new Error('Node.js was not found in this environment');
  }
  if (!commandExists(npmCommand)) {
    throw new Error('npm was not found in this environment');
  }
  if (!commandExists(npxCommand)) {
    throw new Error('npx was not found in this environment');
  }
  if (!commandExists(codexCommand)) {
    throw new Error(`Codex CLI was not found at: ${codexCommand}`);
  }

  const resolvedCodexHome = path.resolve(options.codexHome);
  const resolvedWorkspace = path.resolve(options.workspace);
  const resolvedStorageRoot = path.resolve(options.storageRoot);
  const uploadRoot = path.join(resolvedStorageRoot, 'uploads');
  const queueRoot = path.join(resolvedStorageRoot, 'queue');
  const logRoot = path.join(resolvedStorageRoot, 'logs');

  await mkdir(uploadRoot, { recursive: true });
  await mkdir(queueRoot, { recursive: true });
  await mkdir(logRoot, { recursive: true });

  const profilesJson = options.profilesJson
    ? parseProfilesJson(options.profilesJson)
    : JSON.stringify([
        {
          id: options.profileId,
          label: options.profileLabel,
          codexHome: resolvedCodexHome,
          workspaceCwd: resolvedWorkspace,
          defaultProfile: true,
        },
      ]);

  const envFilePath = path.join(APP_ROOT, '.env');
  const envEntries = await loadExistingEnv(envFilePath);
  const nextEntries = new Map(envEntries);

  const envValues = {
    NODE_ENV: 'production',
    PORT: String(options.port),
    PM2_APP_NAME: options.appName,
    CODEX_OPEN_ACCESS: options.openAccess,
    CODEX_PUBLIC_HOSTS: options.publicHosts,
    CODEX_ALLOW_ANY_PATHS: options.allowAnyPaths,
    CODEX_ALLOWED_FILE_ROOTS: options.extraReadableRoots,
    DATABASE_URL: options.databaseUrl,
    SESSION_SECRET: options.sessionSecret,
    SESSION_COOKIE_DOMAIN: options.cookieDomain,
    CODEX_DEVICE_ADMIN_PASSWORD: options.devicePassword,
    CODEX_BIN: options.codexBin,
    CODEX_APP_ROOT: APP_ROOT,
    CODEX_STORAGE_ROOT: resolvedStorageRoot,
    CODEX_UPLOAD_ROOT: uploadRoot,
    CODEX_QUEUE_ROOT: queueRoot,
    CODEX_LOG_ROOT: logRoot,
    CODEX_PROFILES_JSON: profilesJson,
  };

  for (const [key, value] of Object.entries(envValues)) {
    nextEntries.set(key, value);
  }

  const serializedEnv = [...nextEntries.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await writeFile(envFilePath, `${serializedEnv}\n`, 'utf8');

  if (!options.skipNpmInstall) {
    run(npmCommand, ['install', '--include=dev'], {
      cwd: APP_ROOT,
      env: {
        NODE_ENV: 'development',
        npm_config_production: 'false',
        NPM_CONFIG_PRODUCTION: 'false',
      },
    });
  }

  if (!options.skipBuild) {
    run(npmCommand, ['run', 'build'], { cwd: APP_ROOT });
  }

  if (!options.skipPm2) {
    let hasExistingPm2App = false;
    try {
      run(npxCommand, ['--yes', 'pm2', 'describe', options.appName], { cwd: APP_ROOT, capture: true });
      hasExistingPm2App = true;
    } catch {
      hasExistingPm2App = false;
    }

    if (hasExistingPm2App) {
      run(npxCommand, ['--yes', 'pm2', 'restart', options.appName, '--update-env'], {
        cwd: APP_ROOT,
        env: { PM2_APP_NAME: options.appName },
      });
    } else {
      run(npxCommand, ['--yes', 'pm2', 'start', 'ecosystem.config.cjs', '--update-env'], {
        cwd: APP_ROOT,
        env: { PM2_APP_NAME: options.appName },
      });
    }

    try {
      run(npxCommand, ['--yes', 'pm2', 'save'], { cwd: APP_ROOT });
    } catch {
      // PM2 save is best effort.
    }
  }

  console.log(`
code-ai installed.

App root:        ${APP_ROOT}
App name:        ${options.appName}
Port:            ${options.port}
Codex home:      ${resolvedCodexHome}
Workspace:       ${resolvedWorkspace}
Storage root:    ${resolvedStorageRoot}
Allow any paths: ${options.allowAnyPaths}

Next:
1. Point your reverse proxy/domain to http://127.0.0.1:${options.port}
2. Use deploy/code-ai/nginx-site.conf.template as the base snippet if you are on Linux/Nginx
3. Open the app and verify the profile list and folder picker
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
