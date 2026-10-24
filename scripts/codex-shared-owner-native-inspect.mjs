/** Installed program-code inspection only. Never opens user config, environment, or logs. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const filename = process.argv[2];
if (!filename || !filename.endsWith('/app.asar')) throw new Error('Explicit native program archive path required');
const fd = fs.openSync(filename, 'r');
try {
  const prefix = Buffer.alloc(16);
  fs.readSync(fd, prefix, 0, 16, 0);
  const headerLength = prefix.readUInt32LE(12);
  if (headerLength > 20_000_000) throw new Error('Native archive header exceeds limit');
  const header = Buffer.alloc(headerLength);
  fs.readSync(fd, header, 0, headerLength, 16);
  const tree = JSON.parse(header.toString());
  const builds = tree.files?.['.vite']?.files?.build?.files;
  const chunks = Object.entries(builds ?? {}).filter(([name, entry]) => /^application-network-startup-[A-Za-z0-9_-]+\.js$/.test(name)
    && !entry.files && !entry.unpacked && entry.size < 8_000_000);
  if (chunks.length !== 1) throw new Error('Native daemon transport implementation not uniquely identified');
  const [name, entry] = chunks[0];
  const bytes = Buffer.alloc(entry.size);
  fs.readSync(fd, bytes, 0, entry.size, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
  const source = bytes.toString();
  const checks = {
    optInNativeDaemonEnvironment: source.includes('process.env.CODEX_APP_SERVER_USE_LOCAL_DAEMON===`1`'),
    requiresNoForcedPrivateCli: source.includes('process.env.CODEX_APP_SERVER_FORCE_CLI!==`1`'),
    requiresNoBinaryOverride: source.includes('!process.env.CODEX_CLI_PATH?.trim()'),
    requiresNoCustomLocalCliCommand: source.includes('this.options.hostConfig.codex_cli_command==null'),
    requiresNoStartupConfigOverrides: source.includes('&&!e?.length&&this.options.hostConfig.kind===`local`'),
    canonicalSocket: source.includes('`app-server-control`,`app-server-control.sock`'),
    versionProbe: source.includes('[`app-server`,`daemon`,`version`]'),
    unixWebSocketConnection: source.includes('createConnection:()=>(0,p.createConnection)(n)'),
    windowsExcluded: source.includes('process.platform!==`win32`&&!e?.length'),
    originalCodeModeFlag: source.includes('Ts=[`-c`,`features.code_mode_host=true`]'),
    originalAnalyticsFlag: source.includes('`--analytics-default-enabled`'),
  };
  console.log(JSON.stringify({ format: 'code-ai-native-gui-shared-owner-support', version: 1,
    chunk: `.vite/build/${name}`, chunkSha256: createHash('sha256').update(bytes).digest('hex'), checks,
    linuxNativeDaemonAttachSupported: Object.values(checks).every(Boolean),
    installedEffects: false, liveGuiAttachProven: false, credentialsInspected: false }));
} finally { fs.closeSync(fd); }
