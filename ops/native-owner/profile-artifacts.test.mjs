import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeOwnerArguments, renderDesktopOverride, renderUserUnit, validateProfilePlan } from './profile-artifacts.mjs';

const plan = () => ({
  format: 'code-ai-native-owner-profile', version: 1, profileId: 'ubuntu-refael',
  userHome: '/home/refael', codexHome: '/home/refael/.codex', ownerDirectory: '/home/refael/.code-ai/native-owner/ubuntu-refael',
  nativeBinary: '/usr/lib/chatgpt/resources/codex', nativeBinarySha256: 'a'.repeat(64),
  nodeBinary: '/home/refael/.local/lib/node-v24.21.0-linux-x64/bin/node',
  brokerModule: '/home/refael/.code-ai/native-owner/artifact/broker.mjs', brokerModuleSha256: 'b'.repeat(64),
  dispatcherModule: '/home/refael/.code-ai/native-owner/artifact/codex-shared-cli.mjs',
  adapterModule: '/home/refael/.code-ai/native-owner/artifact/codex-shared-stdio.mjs',
  runnerModule: '/home/refael/.code-ai/native-owner/artifact/profile-runner.mjs',
  guiLauncherModule: '/home/refael/.code-ai/native-owner/artifact/gui-launcher.mjs',
  frontendSocket: '/home/refael/.codex/app-server-control/app-server-control.sock',
  desktopExecutable: '/usr/bin/chatgpt',
  guiBooleanRequirements: {
    'features.code_mode_host': true,
    'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': true,
    'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled': true,
  },
});

test('owner plan retains original binary/home and no new authentication', () => {
  const p = plan(); assert.equal(validateProfilePlan(p), p);
  assert.throws(() => validateProfilePlan({ ...p, token: 'synthetic-refused' }), /Unexpected/);
  assert.throws(() => validateProfilePlan({ ...p, ownerDirectory: '/tmp/foreign' }));
  assert.throws(() => validateProfilePlan({ ...p, frontendSocket: '/tmp/socket' }));
});

test('native owner is Unix-only and preserves all three observed GUI booleans', () => {
  const p = plan(), args = nativeOwnerArguments(p);
  for (const [key, value] of Object.entries(p.guiBooleanRequirements)) assert.ok(args.includes(`${key}=${value}`));
  assert.equal(args.at(-1), `unix://${p.ownerDirectory}/engine.sock`);
  assert.ok(args.includes('--analytics-default-enabled')); assert.equal(args.some(x => x.startsWith('ws://')), false);
});

test('native owner retains existing request-user-input, compaction and MCP-store launch flags', () => {
  const args = nativeOwnerArguments(plan());
  assert.deepEqual(args.slice(0, 6), ['--enable', 'remote_compaction_v2', '--enable',
    'default_mode_request_user_input', '--config', 'mcp_oauth_credentials_store="file"']);
  assert.equal(args.filter(arg => arg === 'app-server').length, 1);
});

test('MCP dispatcher config contains only additive public program and binding paths', () => {
  const p = { ...plan(), mcpDispatchers: [{ serverName: 'personal_chrome', command: '/usr/bin/node',
    args: ['/home/refael/.code-ai/native-owner/artifact/mode-router.mjs'],
    env: { CODE_AI_MODE_SOCKET: '/home/refael/.code-ai/native-owner/ubuntu-refael/modes.sock' },
    required: false, startup_timeout_sec: 20, tool_timeout_sec: 360 }] };
  const args = nativeOwnerArguments(p);
  assert.ok(args.includes('mcp_servers.personal_chrome.command="/usr/bin/node"'));
  assert.ok(args.includes('mcp_servers.personal_chrome.required=false'));
  assert.throws(() => validateProfilePlan({ ...p, mcpDispatchers: [{ ...p.mcpDispatchers[0], env: { API_KEY: 'synthetic-refused' } }] }));
  assert.throws(() => validateProfilePlan({ ...p, mcpDispatchers: [...p.mcpDispatchers, ...p.mcpDispatchers] }));
});

test('user unit owns runner process group without sudo, root account or public listener', () => {
  const p = plan(), unit = renderUserUnit(p, `${p.ownerDirectory}/profile.json`);
  assert.ok(unit.includes('UMask=0077')); assert.ok(unit.includes('KillMode=control-group'));
  assert.ok(unit.includes(`Environment="CODEX_HOME=${p.codexHome}"`));
  assert.equal(/sudo|User=root|0\.0\.0\.0|listen.*tcp/i.test(unit), false);
});

test('per-user desktop override retains original app arguments and all other fields', () => {
  const original = '[Desktop Entry]\nName=ChatGPT\nIcon=chatgpt\nExec=chatgpt --some-public-flag %U\nType=Application\nStartupWMClass=ChatGPT\n';
  const p = plan(), result = renderDesktopOverride(p, `${p.ownerDirectory}/profile.json`, original);
  assert.equal(result.originalExec, 'chatgpt --some-public-flag %U');
  assert.equal(result.argsRetained, ' --some-public-flag %U');
  assert.ok(result.content.includes(' --some-public-flag %U\n'));
  for (const line of ['Name=ChatGPT', 'Icon=chatgpt', 'StartupWMClass=ChatGPT']) assert.ok(result.content.includes(line));
  assert.equal(result.originalDesktopUnmodified, true);
  assert.throws(() => renderDesktopOverride(p, `${p.ownerDirectory}/profile.json`, 'Exec=some-other-app\n'));
});

test('DBus activation cannot bypass the explicit next-launch owner adapter', () => {
  const p = plan(), result = renderDesktopOverride(p, `${p.ownerDirectory}/profile.json`,
    '[Desktop Entry]\nExec=/usr/bin/chatgpt %U\nDBusActivatable=true\n');
  assert.ok(result.content.includes('DBusActivatable=false')); assert.ok(result.content.includes(' %U\n'));
});
