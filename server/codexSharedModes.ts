import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { CODEX_APP_CONFIG, type CodexProfileConfig } from './config.js';
import { getSessionPersonalChromeModeRecord, rebindSessionPersonalChromeMode } from './codexPersonalChromeMode.js';
import { getSessionPhoneModeRecord, dispatchPhoneNativeModeTool, rebindSessionPhoneMode } from './codexPhoneMode.js';
import { getSessionDesignModeRecord, dispatchDesignNativeModeTool, rebindSessionDesignMode } from './codexDesignMode.js';
import { getSessionUxModeRecord, dispatchUxNativeModeTool, rebindSessionUxMode } from './codexUxMode.js';
import { getSessionBrowserModeRecord, rebindSessionBrowserMode } from './codexBrowserMode.js';
import { dispatchBrowserNativeModeTool } from './codexBrowserViewer.js';
import { createSharedModeBridge, modeServers, modeError } from './codex-shared-modes/transport.mjs';
import { modeResult } from './codex-shared-modes/results.mjs';
import { createModeContexts } from './codex-shared-modes/contexts.mjs';
import { recoverModeEndpoint } from './codex-shared-modes/endpoint.mjs';
import { resolveCodexRuntimeProgram } from './codexRuntimePrograms.mjs';

const execute = promisify(execFile);
export type SharedModeServer = 'personal_chrome' | 'browser_mode' | 'phone_mode' | 'design_mode' | 'ux_mode';
export interface SharedModeCall {
  server: SharedModeServer;
  nativeThreadId: string;
  nativeItemId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
}
export type SharedModeBindings = Partial<Record<SharedModeServer, { profileId: string; sessionKey: string } | null>>;
export interface SharedModeBridge {
  socketPath: string;
  mcpConfigurations: Record<SharedModeServer, { command: string; args: string[]; required: false; startup_timeout_sec: number; tool_timeout_sec: number }>;
  catalogIdentities: Record<SharedModeServer, string>;
  close(): Promise<void>;
}
const bridges = new Map<string, Promise<SharedModeBridge>>();
const contextsByProfile = new Map<string, Awaited<ReturnType<typeof createModeContexts>>>();

/** Called only by trusted queue/preparation code, not an MCP tool or public route. */
export async function bindCodexSharedModeContext(profileId: string, nativeThreadId: string, bindings: SharedModeBindings): Promise<void> {
  const contexts = contextsByProfile.get(profileId);
  if (!contexts) throw modeError('MODE_UNAVAILABLE');
  await contexts.set(nativeThreadId, bindings);
}

/** Invoke only after the existing queue has completed its proven source -> native state rebind. */
export async function refreshCodexSharedModeContextAfterRebind(
  nativeProfileId: string, nativeThreadId: string, server: SharedModeServer, stateProfileId: string, previousSessionKey: string,
): Promise<boolean> {
  const contexts = contextsByProfile.get(nativeProfileId);
  if (!contexts || previousSessionKey === nativeThreadId) return false;
  const getter = server === 'personal_chrome' ? getSessionPersonalChromeModeRecord
    : server === 'browser_mode' ? getSessionBrowserModeRecord
    : server === 'phone_mode' ? getSessionPhoneModeRecord
    : server === 'design_mode' ? getSessionDesignModeRecord : getSessionUxModeRecord;
  const [previous, actual] = await Promise.all([getter(stateProfileId, previousSessionKey), getter(stateProfileId, nativeThreadId)]);
  if (previous || !actual) return false;
  return contexts.relocate(nativeThreadId, server,
    { profileId: stateProfileId, sessionKey: previousSessionKey }, { profileId: stateProfileId, sessionKey: nativeThreadId });
}
function modeContext(profileId: string, nativeThreadId: string, server: SharedModeServer): { profileId: string; sessionKey: string } {
  const explicit = contextsByProfile.get(profileId)?.get(nativeThreadId, server);
  if (explicit === null) throw modeError('MODE_UNBOUND');
  return explicit || { profileId, sessionKey: nativeThreadId };
}

/** Public availability only; never exposes private binding or provider credentials. */
export async function getCodexSharedModeAvailability(profileId: string, nativeThreadId: string): Promise<Record<SharedModeServer, boolean>> {
  const context = (server: SharedModeServer) => {
    try { return modeContext(profileId, nativeThreadId, server); } catch { return null; }
  };
  const chromeContext = context('personal_chrome'), browserContext = context('browser_mode'), phoneContext = context('phone_mode'),
    designContext = context('design_mode'), uxContext = context('ux_mode');
  const [chrome, browser, phone, design, ux] = await Promise.all([
    chromeContext && getSessionPersonalChromeModeRecord(chromeContext.profileId, chromeContext.sessionKey),
    browserContext && getSessionBrowserModeRecord(browserContext.profileId, browserContext.sessionKey),
    phoneContext && getSessionPhoneModeRecord(phoneContext.profileId, phoneContext.sessionKey),
    designContext && getSessionDesignModeRecord(designContext.profileId, designContext.sessionKey),
    uxContext && getSessionUxModeRecord(uxContext.profileId, uxContext.sessionKey),
  ]);
  return { personal_chrome: chrome?.enabled === true, browser_mode: browser?.enabled === true,
    phone_mode: phone?.enabled === true, design_mode: design?.enabled === true, ux_mode: ux?.enabled === true };
}

/** Call before queue/add for a newly created native thread. */
export async function rebindCodexSharedModeSession(profileId: string, fromSessionKey: string, nativeThreadId: string): Promise<void> {
  await Promise.all([
    rebindSessionPersonalChromeMode(profileId, fromSessionKey, nativeThreadId),
    rebindSessionBrowserMode(profileId, fromSessionKey, nativeThreadId),
    rebindSessionPhoneMode(profileId, fromSessionKey, nativeThreadId),
    rebindSessionDesignMode(profileId, fromSessionKey, nativeThreadId),
    rebindSessionUxMode(profileId, fromSessionKey, nativeThreadId),
  ]);
}

async function resolveMode(profile: CodexProfileConfig, call: SharedModeCall): Promise<unknown> {
  const context = modeContext(profile.id, call.nativeThreadId, call.server);
  const id = context.profileId, session = context.sessionKey;
  // No descendant/root guessing: an unknown native thread has no mode binding.
  if (call.server === 'personal_chrome') {
    const record = await getSessionPersonalChromeModeRecord(id, session);
    if (!record) throw modeError('MODE_UNBOUND');
    if (!record.enabled) throw modeError('MODE_DISABLED');
    if (!record.bindingToken || !record.controlUrl) throw modeError('MODE_UNAVAILABLE');
    // Retain the original authorized endpoint: remote records may refer to main's
    // binding, not this agent's local bridge. Its normal validator enforces scope,
    // approval and the original browser workspace. URL/token are never model input.
    const response = await fetch(`${record.controlUrl.replace(/\/+$/, '')}/api/codex/browser-extension/tool-call`, {
      method: 'POST', headers: { authorization: `Bearer ${record.bindingToken}`, 'content-type': 'application/json',
        'user-agent': `code-ai-personal-chrome-mcp/1 device/${record.deviceId || 'unknown'}` },
      body: JSON.stringify({ toolName: call.toolName, arguments: call.arguments }), signal: AbortSignal.timeout(125000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false || !payload || !Object.hasOwn(payload, 'result')) {
      throw modeError(typeof payload?.error?.code === 'string' ? payload.error.code : 'MODE_TOOL_FAILED');
    }
    return payload.result;
  }
  if (call.server === 'phone_mode') {
    if (!await getSessionPhoneModeRecord(id, session)) throw modeError('MODE_UNBOUND');
    return dispatchPhoneNativeModeTool(id, session, call.toolName, call.arguments);
  }
  if (call.server === 'design_mode') {
    if (!await getSessionDesignModeRecord(id, session)) throw modeError('MODE_UNBOUND');
    return dispatchDesignNativeModeTool(id, session, call.toolName, call.arguments);
  }
  if (call.server === 'ux_mode') {
    if (!await getSessionUxModeRecord(id, session)) throw modeError('MODE_UNBOUND');
    return dispatchUxNativeModeTool(id, session, call.toolName, call.arguments);
  }
  if (!await getSessionBrowserModeRecord(id, session)) throw modeError('MODE_UNBOUND');
  return dispatchBrowserNativeModeTool(profile, session, call.toolName, call.arguments, id);
}

/** Stable same-user private endpoint; no dependency on the installed app path. */
export async function ensureCodexSharedModeBridge(profile: CodexProfileConfig, expectedIdentity?: { uid: number; gid: number }): Promise<SharedModeBridge> {
  const canonicalHome = await fs.realpath(profile.codexHome);
  const home = await fs.lstat(canonicalHome);
  if (!home.isDirectory()) throw modeError('MODE_ENDPOINT_INVALID');
  const { uid, gid } = expectedIdentity || { uid: home.uid, gid: home.gid };
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) throw modeError('MODE_ENDPOINT_INVALID');
  const key = canonicalHome + '\0' + profile.id + '\0' + uid + ':' + gid;
  const existing = bridges.get(key); if (existing) return existing;
  const creation = (async () => {
    const directory = path.join(canonicalHome, 'code-ai-shared-owner');
    const previous = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous && (!previous.isDirectory() || previous.isSymbolicLink() || previous.uid !== uid || (previous.mode & 0o077))) {
      throw modeError('MODE_ENDPOINT_INVALID');
    }
    if (!previous) { await fs.mkdir(directory, { mode: 0o700 }); await fs.chown(directory, uid, gid); }
    const socketPath = path.join(directory, 'modes.sock');
    await recoverModeEndpoint(socketPath, uid);
    const contexts = await createModeContexts(directory, uid, gid);
    const config = {} as SharedModeBridge['mcpConfigurations'];
    const identities = {} as SharedModeBridge['catalogIdentities'];
    const catalogs = new Map<string, Set<string>>();
    const frontend = resolveCodexRuntimeProgram('sharedModes', {sourceRoot:CODEX_APP_CONFIG.appRoot});
    for (const server of modeServers as SharedModeServer[]) {
      const source = resolveCodexRuntimeProgram(server, {sourceRoot:CODEX_APP_CONFIG.appRoot});
      const { stdout } = await execute(server === 'browser_mode' ? '/usr/bin/python3' : process.execPath,
        [source, '--describe-tools'], { timeout: 10000, maxBuffer: 2 * 1024 * 1024,
          env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
      let catalog;
      try { catalog = JSON.parse(stdout); } catch { throw modeError('MODE_CATALOG_INVALID'); }
      if (!Array.isArray(catalog?.tools) || !catalog.tools.length
          || catalog.tools.some((tool: any) => typeof tool?.name !== 'string' || !tool.inputSchema)) throw modeError('MODE_CATALOG_INVALID');
      catalogs.set(server, new Set(catalog.tools.map((tool: any) => tool.name)));
      const content = JSON.stringify(catalog) + '\n', catalogPath = path.join(directory, `${server}-tools.json`);
      const old = await fs.lstat(catalogPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (old && (!old.isFile() || old.isSymbolicLink() || old.uid !== uid || (old.mode & 0o077))) throw modeError('MODE_CATALOG_INVALID');
      await fs.writeFile(catalogPath, content, { mode: 0o600 }); await fs.chown(catalogPath, uid, gid);
      identities[server] = createHash('sha256').update(content).digest('hex');
      config[server] = { command: process.execPath,
        args: [frontend, '--server', server, '--socket', path.join(directory, 'modes.sock'), '--catalog', catalogPath],
        required: false, startup_timeout_sec: 20, tool_timeout_sec: 360 };
    }
    const bridge = await createSharedModeBridge({ socketPath, uid, gid,
      resolve: async (call: SharedModeCall) => {
        if (!catalogs.get(call.server)?.has(call.toolName)) throw modeError('UNKNOWN_TOOL');
        const result = await resolveMode(profile, call);
        return modeResult(call.server, result);
      } });
    contextsByProfile.set(profile.id, contexts);
    return { socketPath: bridge.socketPath, mcpConfigurations: config, catalogIdentities: identities,
      close: async () => { await bridge.close(); bridges.delete(key);
        if (contextsByProfile.get(profile.id) === contexts) contextsByProfile.delete(profile.id); } };
  })();
  bridges.set(key, creation);
  try { return await creation; } catch (error) { bridges.delete(key); throw error; }
}
export async function closeCodexSharedModeBridges(): Promise<void> {
  await Promise.all([...bridges.values()].map(async value => (await value).close()));
}
