/** Reversible per-user native-owner artifacts. Rendering performs no installation. */
import assert from 'node:assert/strict';
import path from 'node:path';

const keys = new Set(['format', 'version', 'profileId', 'userHome', 'codexHome', 'ownerDirectory',
  'nativeBinary', 'nativeBinarySha256', 'nodeBinary', 'brokerModule', 'brokerModuleSha256',
  'dispatcherModule', 'adapterModule', 'runnerModule', 'guiLauncherModule', 'frontendSocket',
  'guiBooleanRequirements', 'mcpDispatchers', 'desktopExecutable']);
const modeNames = new Set(['personal_chrome', 'browser_mode', 'phone_mode', 'design_mode', 'ux_mode']);
const guiKeys = [
  'features.code_mode_host',
  'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled',
  'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled',
];
const plainPath = p => typeof p === 'string' && path.isAbsolute(p) && !/[\0\r\n"`$\\]/.test(p);

export function validateProfilePlan(plan) {
  assert.ok(plan && typeof plan === 'object' && !Array.isArray(plan));
  assert.ok(Object.keys(plan).every(key => keys.has(key)), 'Unexpected owner-plan field');
  assert.equal(plan.format, 'code-ai-native-owner-profile'); assert.equal(plan.version, 1);
  assert.match(plan.profileId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  for (const key of ['userHome', 'codexHome', 'ownerDirectory', 'nativeBinary', 'nodeBinary', 'brokerModule',
    'dispatcherModule', 'adapterModule', 'runnerModule', 'guiLauncherModule', 'frontendSocket', 'desktopExecutable']) {
    assert.ok(plainPath(plan[key]), `Explicit public path required: ${key}`);
  }
  assert.match(plan.nativeBinarySha256, /^[a-f0-9]{64}$/); assert.match(plan.brokerModuleSha256, /^[a-f0-9]{64}$/);
  assert.ok(plan.ownerDirectory.startsWith(plan.userHome + '/') && plan.codexHome.startsWith(plan.userHome + '/'));
  const productSocket = path.join(plan.codexHome, 'code-ai-shared-owner/owner.sock');
  const nativeSocket = path.join(plan.codexHome, 'app-server-control/app-server-control.sock');
  assert.ok(plan.frontendSocket === productSocket || plan.frontendSocket === nativeSocket, 'Explicit qualified frontend required');
  assert.deepEqual(Object.keys(plan.guiBooleanRequirements).sort(), [...guiKeys].sort());
  for (const key of guiKeys) assert.equal(typeof plan.guiBooleanRequirements[key], 'boolean');
  assert.equal(plan.guiBooleanRequirements['features.code_mode_host'], true);
  if (plan.mcpDispatchers != null) {
    assert.ok(Array.isArray(plan.mcpDispatchers) && plan.mcpDispatchers.length <= 5);
    const names = new Set();
    for (const d of plan.mcpDispatchers) {
    const allowed = new Set(['args', 'command', 'env', 'serverName', 'required', 'startup_timeout_sec', 'tool_timeout_sec']);
    assert.ok(Object.keys(d).every(key => allowed.has(key)));
    assert.ok(modeNames.has(d.serverName) && !names.has(d.serverName)); names.add(d.serverName);
    assert.ok(plainPath(d.command)); assert.ok(Array.isArray(d.args) && d.args.length <= 12);
    for (const arg of d.args) assert.ok(typeof arg === 'string' && arg.length <= 4096 && !/[\0\r\n]/.test(arg));
    assert.equal(d.required, false);
    assert.ok(Number.isInteger(d.startup_timeout_sec) && d.startup_timeout_sec > 0 && d.startup_timeout_sec <= 120);
    assert.ok(Number.isInteger(d.tool_timeout_sec) && d.tool_timeout_sec > 0 && d.tool_timeout_sec <= 3600);
    assert.ok(d.env == null || (typeof d.env === 'object' && !Array.isArray(d.env)));
    // Credentials stay in the existing per-thread private mode binding, not the owner plan.
    for (const [name, value] of Object.entries(d.env ?? {})) {
      assert.match(name, /^[A-Z][A-Z0-9_]{0,63}$/);
      assert.ok(!/TOKEN|SECRET|PASSWORD|AUTH|API_KEY/i.test(name));
      assert.ok(typeof value === 'string' && value.length <= 4096 && !/[\0\r\n]/.test(value));
    }
    }
  }
  return plan;
}

export function nativeOwnerArguments(plan) {
  validateProfilePlan(plan);
  const args = ['--enable', 'remote_compaction_v2', '--enable', 'default_mode_request_user_input',
    '--config', 'mcp_oauth_credentials_store="file"',
    ...Object.entries(plan.guiBooleanRequirements).flatMap(([key, value]) => ['-c', `${key}=${value}`])];
  for (const d of plan.mcpDispatchers ?? []) {
    const base = `mcp_servers.${d.serverName}`;
    args.push('-c', `${base}.command=${JSON.stringify(d.command)}`, '-c', `${base}.args=${JSON.stringify(d.args)}`);
    args.push('-c', `${base}.required=false`, '-c', `${base}.startup_timeout_sec=${d.startup_timeout_sec}`,
      '-c', `${base}.tool_timeout_sec=${d.tool_timeout_sec}`);
    for (const [name, value] of Object.entries(d.env ?? {})) args.push('-c', `${base}.env.${name}=${JSON.stringify(value)}`);
  }
  args.push('app-server', '--analytics-default-enabled', '--listen', `unix://${path.join(plan.ownerDirectory, 'engine.sock')}`);
  return args;
}

function unitQuote(value) { return `"${value.replaceAll('"', '\\"')}"`; }

export function renderUserUnit(plan, planPath) {
  validateProfilePlan(plan); assert.ok(plainPath(planPath));
  return `[Unit]\nDescription=Code AI shared native owner (${plan.profileId})\nAfter=default.target\n\n[Service]\nType=simple\nUMask=0077\nEnvironment=${unitQuote(`HOME=${plan.userHome}`)}\nEnvironment=${unitQuote(`CODEX_HOME=${plan.codexHome}`)}\nEnvironment=${unitQuote(`CODEX_CLI_PATH=${plan.nativeBinary}`)}\nExecStart=${unitQuote(plan.nodeBinary)} ${unitQuote(plan.runnerModule)} ${unitQuote(planPath)}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
}

export function renderDesktopOverride(plan, planPath, original) {
  validateProfilePlan(plan); assert.ok(plainPath(planPath));
  assert.ok(typeof original === 'string' && original.length < 32_768 && !original.includes('\0'));
  const matches = [...original.matchAll(/^Exec=(.*)$/gm)]; assert.equal(matches.length, 1, 'Unique original desktop launch required');
  const sourceExec = matches[0][1];
  const executable = sourceExec.match(/^(?:"([^"]+)"|(\S+))([\s\S]*)$/);
  assert.ok(executable); const sourceProgram = executable[1] ?? executable[2];
  assert.ok(sourceProgram === plan.desktopExecutable || sourceProgram === path.basename(plan.desktopExecutable), 'Desktop executable changed');
  const args = executable[3];
  const replacement = `Exec=${unitQuote(plan.nodeBinary)} ${unitQuote(plan.guiLauncherModule)} ${unitQuote(planPath)}${args}`;
  let changed = original.replace(/^Exec=.*$/m, replacement);
  if (/^DBusActivatable=/m.test(changed)) changed = changed.replace(/^DBusActivatable=.*$/m, 'DBusActivatable=false');
  return { content: changed, originalExec: sourceExec, argsRetained: args,
    originalDesktopUnmodified: true, onlyPerUserOverride: true };
}
