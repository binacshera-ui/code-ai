/**
 * Exact-native MCP routing proof. Disposable home, synthetic bindings and a
 * loopback fake provider only; never reads auth or mutates an installed owner.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv.includes('--synthetic-mcp')) {
  const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    void (async () => {
      const id = message.id;
      if (message.method === 'initialize') {
        write({ id, result: { protocolVersion: message.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} }, serverInfo: { name: 'synthetic-mode-contract', version: '1' } } });
      } else if (message.method === 'ping') write({ id, result: {} });
      else if (message.method === 'tools/list') write({ id, result: { tools: [{ name: 'probe',
        description: 'Synthetic read-only routing contract probe.',
        inputSchema: { type: 'object', properties: { claimedThreadId: { type: 'string' } }, additionalProperties: false },
        ...(!process.argv.includes('--unannotated') ? { annotations: { readOnlyHint: true, destructiveHint: false } } : {}) }] } });
      else if (message.method === 'tools/call') {
        await appendFile(process.env.CODE_AI_SYNTHETIC_MCP_RECORD, JSON.stringify({
          threadId: message.params?._meta?.threadId ?? null,
          itemIdPresent: typeof message.params?._meta?.itemId === 'string',
          claimedThreadId: message.params?.arguments?.claimedThreadId ?? null,
          binding: process.env.CODE_AI_SYNTHETIC_MCP_BINDING ?? null,
        }) + '\n', { mode: 0o600 });
        write({ id, result: { content: [{ type: 'text', text: 'Synthetic routing probe passed.' }] } });
      } else if (id !== undefined) write({ id, error: { code: -32601, message: 'Fixture method unsupported' } });
    })().catch(() => { if (message.id !== undefined) write({ id: message.id, error: { code: -32603, message: 'Fixture failed' } }); });
  });
} else {
  await runContract();
}

async function runContract() {
  const bin = process.argv[2];
  assert.ok(bin && path.isAbsolute(bin), 'Explicit absolute native binary required');
  const dispatcherIndex = process.argv.indexOf('--dispatcher-root');
  const dispatcherRoot = dispatcherIndex >= 0 ? process.argv[dispatcherIndex + 1] : null;
  const unannotated = process.argv.includes('--unannotated');
  const fullAccess = process.argv.includes('--full-access');
  const codeMode = process.argv.includes('--code-mode');
  const latePermissions = process.argv.includes('--late-permissions');
  const restorePermissions = process.argv.includes('--restore-permissions');
  const brokerEnabled = process.argv.includes('--broker');
  const svgImage = process.argv.includes('--svg-image');
  const svgFile = process.argv.includes('--svg-file');
  const broker = brokerEnabled ? new (await import('../server/codexSharedOwnerBroker.mjs')).CodexSharedOwnerBroker() : null;
  assert.ok(!dispatcherRoot || path.isAbsolute(dispatcherRoot), 'Dispatcher fixture root must be absolute');
  const WebSocket = (await import('ws')).default;
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-mode-contract-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
  const record = path.join(root, 'synthetic-mcp-record.jsonl');
  const socket = path.join(home, 'app-server-control', 'app-server-control.sock');
  await mkdir(home, { mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
  await writeFile(record, '', { mode: 0o600 });
  const svgPath = path.join(cwd, 'synthetic-cursor.svg');
  if (svgImage || svgFile) await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M1 1 L20 8 L9 12 Z"/></svg>');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CODEX|OPENAI/i.test(key)));
  Object.assign(env, { CODEX_HOME: home, HOME: root, CODE_AI_SYNTHETIC_MCP_RECORD: record });
  const bindings = new Map();
  let modeBridge, modeTransport, modeSocket, modeCatalog;
  if (dispatcherRoot) {
    modeTransport = await import(pathToFileURL(path.join(dispatcherRoot, 'transport.mjs')).href);
    const modeDirectory = path.join(home, 'code-ai-shared-owner'); await mkdir(modeDirectory, { mode: 0o700 });
    modeSocket = path.join(modeDirectory, 'modes.sock'); modeCatalog = path.join(modeDirectory, 'design_mode-tools.json');
    await writeFile(modeCatalog, JSON.stringify({ tools: [{ name: 'probe', description: 'Synthetic read-only native dispatcher proof.',
      inputSchema: { type: 'object', properties: { claimedThreadId: { type: 'string' } }, additionalProperties: false },
      annotations: { readOnlyHint: true } }] }) + '\n', { mode: 0o600 });
    const resolver = async request => {
      const binding = bindings.get(request.nativeThreadId);
      await appendFile(record, JSON.stringify({ threadId: request.nativeThreadId,
        itemIdPresent: typeof request.nativeItemId === 'string', claimedThreadId: request.arguments.claimedThreadId ?? null,
        binding: binding?.value ?? null, enabled: binding?.enabled === true }) + '\n', { mode: 0o600 });
      if (!binding) throw modeTransport.modeError('MODE_UNBOUND');
      if (!binding.enabled) throw modeTransport.modeError('MODE_DISABLED');
      return { content: [{ type: 'text', text: 'Synthetic dispatcher routing probe passed.' }] };
    };
    modeBridge = await modeTransport.createSharedModeBridge({ socketPath: modeSocket, uid: process.getuid(), gid: process.getgid(), resolve: resolver });
    modeBridge.fixtureResolver = resolver;
  }
  let requests = 0, nextResponse = 0, toolAdvertised = false, beforeTool;
  const requestedTool = body => {
    if (codeMode) return { name: 'exec' };
    for (const tool of body.tools || []) {
      if (tool.type === 'namespace' && typeof tool.name === 'string') {
        const probe = (tool.tools || []).find(child => child.name === 'probe');
        if (probe) return { name: probe.name, namespace: tool.name };
      }
      if (typeof tool.name === 'string' && /mcp__(contract_mode|design_mode).*probe/.test(tool.name)) return { name: tool.name };
      if (tool.type === 'function' && typeof tool.function?.name === 'string'
          && /mcp__(contract_mode|design_mode).*probe/.test(tool.function.name)) return { name: tool.function.name };
    }
    return null;
  };
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { req.resume(); res.writeHead(404).end(); return; }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (beforeTool) { const restore = beforeTool; beforeTool = null; await restore(); }
      const tool = requestedTool(body);
      toolAdvertised ||= Boolean(tool);
      const n = ++nextResponse;
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      const event = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      event({ type: 'response.created', response: { id: `synthetic-mode-${n}` } });
      if (requests % 2 === 1 && tool) {
        const item = codeMode ? { type: 'custom_tool_call', id: `probe-${n}`, call_id: `call-${n}`, name: 'exec',
          input: `text(await tools.mcp__${dispatcherRoot ? 'design_mode' : 'contract_mode'}__probe({claimedThreadId:"model-supplied-wrong-thread"}));` }
          : { type: 'function_call', id: `probe-${n}`, call_id: `call-${n}`,
            ...tool, arguments: JSON.stringify({ claimedThreadId: 'model-supplied-wrong-thread' }) };
        event({ type: 'response.output_item.done', item });
      } else {
        event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant',
          id: `answer-${n}`, content: [{ type: 'output_text', text: 'Synthetic mode contract answer.' }] } });
      }
      event({ type: 'response.completed', response: { id: `synthetic-mode-${n}`,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      res.end();
    } catch { req.resume(); res.writeHead(500).end(); }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const toml = value => JSON.stringify(value);
  await writeFile(path.join(home, 'config.toml'), [
    'model = "mock-model"', 'model_provider = "contract"', 'model_reasoning_effort = "medium"', `approval_policy = "${latePermissions || broker ? 'on-request' : 'never'}"`, `sandbox_mode = "${fullAccess && !latePermissions && !broker ? 'danger-full-access' : 'read-only'}"`,
    '[features]', `code_mode = ${codeMode}`, `code_mode_host = ${codeMode}`,
    '[model_providers.contract]', 'name = "Isolated mode fake provider"',
    `base_url = "http://127.0.0.1:${provider.address().port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
    ...(dispatcherRoot ? [
      '[mcp_servers.design_mode]', `command = ${toml(process.execPath)}`,
      `args = [${[path.join(dispatcherRoot, 'mcp.mjs'), '--server', 'design_mode', '--socket', modeSocket, '--catalog', modeCatalog].map(toml).join(', ')}]`,
      'required = true',
    ] : [
      '[mcp_servers.contract_mode]', `command = ${toml(process.execPath)}`,
      `args = [${toml(fileURLToPath(import.meta.url))}, "--synthetic-mcp"${unannotated ? ', "--unannotated"' : ''}]`, 'required = true',
      '[mcp_servers.contract_mode.env]', `CODE_AI_SYNTHETIC_MCP_RECORD = ${toml(record)}`,
      'CODE_AI_SYNTHETIC_MCP_BINDING = "canonical"',
    ]),
  ].join('\n') + '\n', { mode: 0o600 });
  const nativeVersion = await new Promise((resolve, reject) => execFile(bin, ['--version'], { env, cwd, timeout: 10000 },
    (error, stdout) => error ? reject(new Error('Fixture version unavailable')) : resolve(stdout.trim())));
  const owner = spawn(bin, ['app-server', '--listen', 'unix://'], { env, cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  owner.stderr.resume(); let ownerError = false;
  owner.on('error', () => { ownerError = true; });
  const clients = [], serverRequests = [], nativeRejections = []; let passed = 0, lastRpc = null;
  const wait = async predicate => {
    const deadline = Date.now() + 35000;
    while (!await predicate()) {
      if (Date.now() > deadline || ownerError || owner.exitCode !== null) throw new Error('Synthetic native mode fixture timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const connect = async () => {
    const ws = new WebSocket(`ws+unix://${socket}:/`, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5000 });
    clients.push(ws); await once(ws, 'open');
    let id = 0; const pending = new Map(), events = [];
    ws.on('message', bytes => {
      const frame = JSON.parse(bytes.toString()), call = pending.get(frame.id);
      if (frame.method && frame.id !== undefined) {
        serverRequests.push(frame.method);
        ws.send(JSON.stringify({ id: frame.id, result: { action: 'decline' } }));
        return;
      }
      if (!call) { events.push(frame); return; }
      pending.delete(frame.id); clearTimeout(call.timer); call.resolve(frame);
    });
    const call = (method, params) => new Promise((resolve, reject) => {
      const current = ++id;
      pending.set(current, { resolve: value => {
        lastRpc = { method, ok: !value.error, code: value.error?.code ?? null,
          ...(value.error ? { message: String(value.error.message).slice(0, 500) } : {}) }; resolve(value);
        if (value.error && nativeRejections.length < 20) nativeRejections.push(lastRpc);
      }, timer: setTimeout(() => { pending.delete(current); reject(new Error('Synthetic native mode RPC timed out')); }, 15000) });
      ws.send(JSON.stringify({ id: current, method, params }));
    });
    const initialized = await call('initialize', { clientInfo: { name: 'code-ai-synthetic-mode', version: '1' },
      capabilities: { experimentalApi: true } });
    assert.equal(initialized.error, undefined); assert.equal(initialized.result.codexHome, home);
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    const channel = { clientName: 'code-ai', call: async (method, params) => {
      const frame = await call(method, params);
      if (frame.error) throw Object.assign(new Error('Fixture native request rejected'), { nativeRejected: true, code: frame.error.code });
      return frame.result;
    } };
    if (broker) ws.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.method && frame.id === undefined) void broker.observe(channel, frame).catch(() => { ownerError = true; });
    });
    return { call, events, channel };
  };
  const records = async () => (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  try {
    await wait(() => stat(socket).then(value => value.isSocket(), () => false));
    const gui = await connect(), web = await connect();
    const makeThread = async binding => {
      const result = await gui.call('thread/start', { cwd, ephemeral: false,
        ...(dispatcherRoot ? {} : { config: { 'mcp_servers.contract_mode.env.CODE_AI_SYNTHETIC_MCP_BINDING': binding } }) });
      assert.equal(result.error, undefined);
      if (broker) { broker.ownerModes.set(result.result.thread.id, 'default'); broker.freshStates.set(result.result.thread.id, result.result); }
      if (dispatcherRoot) bindings.set(result.result.thread.id, { value: binding, enabled: true });
      if (latePermissions) {
        const threadId = result.result.thread.id;
        const update = await gui.call('thread/settings/update', { threadId, approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' } });
        assert.equal(update.error, undefined);
        await wait(() => gui.events.some(frame => frame.method === 'thread/settings/updated' && frame.params?.threadId === threadId));
      }
      return result.result.thread.id;
    };
    const a = await makeThread('thread-A'), b = await makeThread('thread-B'); passed++;
    const turn = async (threadId, ordinal) => {
      if (restorePermissions) {
        await gui.call('thread/settings/update', { threadId, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
        beforeTool = () => gui.call('thread/settings/update', { threadId, approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
      }
      const params = { threadId, input: [{ type: 'text', text: 'Call the synthetic routing probe once, then answer.', text_elements: [] }] };
      if (svgImage) params.input.push({ type: 'localImage', path: svgPath });
      if (svgFile) params.input[0].text += `\nAttached files available in the workspace:\n- synthetic-cursor.svg (file, image/svg+xml) => ${svgPath}\nInspect these files directly if they are relevant to the request.`;
      let turnId;
      if (broker) {
        const clientId = `fixture-mode-${ordinal}`;
        await broker.handle(gui.channel, { method: 'thread/queue/add', params: { ...params,
          clientUserMessageId: clientId, codeAiTurnSettings: { model: 'mock-model', effort: 'medium', cwd,
            approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } } });
        await wait(() => gui.events.some(frame => frame.method === 'item/started' && frame.params?.item?.clientId === clientId));
        turnId = gui.events.find(frame => frame.method === 'item/started' && frame.params?.item?.clientId === clientId).params.turnId;
      } else {
        const result = await gui.call('turn/start', params);
        assert.equal(result.error, undefined); turnId = result.result.turn.id;
      }
      await wait(() => gui.events.some(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === turnId));
      if (broker) {
        await wait(() => broker.records.get(threadId)?.phase === 'released');
        assert.equal(broker.records.get(threadId).turnComplete, true);
        const restored = await gui.channel.call('thread/resume', { threadId, excludeTurns: true });
        assert.equal(restored.approvalPolicy, 'on-request'); assert.equal(restored.sandbox.type, 'readOnly');
      }
      const calls = await records(); assert.equal(calls.length, ordinal); return calls.at(-1);
    };
    const first = await turn(a, 1); assert.equal(first.threadId, a); assert.equal(first.claimedThreadId, 'model-supplied-wrong-thread'); passed++;
    assert.equal(first.binding, 'thread-A'); passed++;
    const second = await turn(b, 2); assert.equal(second.threadId, b); assert.equal(second.binding, 'thread-B'); passed++;
    const resume = await web.call('thread/resume', { threadId: a, excludeTurns: true,
      config: { [`mcp_servers.${dispatcherRoot ? 'design_mode' : 'contract_mode'}.env.CODE_AI_SYNTHETIC_MCP_BINDING`]: 'resume-override' } });
    assert.equal(resume.error, undefined); passed++;
    const third = await turn(a, 3); assert.equal(third.threadId, a); assert.equal(third.binding, 'thread-A'); passed++;
    assert.ok(toolAdvertised); assert.equal(requests, 6); passed++;
    if (dispatcherRoot) {
      const resolver = modeBridge.fixtureResolver;
      await modeBridge.close();
      modeBridge = await modeTransport.createSharedModeBridge({ socketPath: modeSocket, uid: process.getuid(), gid: process.getgid(), resolve: resolver });
      modeBridge.fixtureResolver = resolver;
      const reconnected = await turn(a, 4);
      assert.equal(reconnected.threadId, a); assert.equal(reconnected.binding, 'thread-A'); passed++;
      bindings.get(a).enabled = false;
      const revoked = await turn(a, 5); assert.equal(revoked.threadId, a); assert.equal(revoked.enabled, false); passed++;
      const unknown = await modeTransport.callSharedMode(modeSocket, 'design_mode', { name: 'probe', _meta: { threadId: 'unbound-native-child' } });
      assert.equal(unknown.structuredContent.error_code, 'MODE_UNBOUND'); passed++;
      await assert.rejects(modeTransport.callSharedMode(modeSocket, 'design_mode', { name: 'probe', arguments: { threadId: a } }), { code: 'MODE_UNBOUND' }); passed++;
    }
    console.log(JSON.stringify({ format: 'code-ai-native-shared-mode-contract', nativeVersion,
      synthetic: true, installedEffects: false, realProviderCalls: 0, passed, loopbackFakeProviderCalls: requests,
      fullAccess, unannotated, codeMode, latePermissions, restorePermissions, brokerEnabled, serverRequests, nativeRejections,
      nativeMcpThreadIdPresent: true, modelClaimNotUsedForRouting: true,
      threadStartMcpOverridesIsolated: !dispatcherRoot, loadedResumeMcpOverrideIgnored: !dispatcherRoot,
      genericCanonicalDispatcherRoutingViable: true,
      actualDispatcherFrontendProven: Boolean(dispatcherRoot), backendRestartWhileNativeRemainsLiveProven: Boolean(dispatcherRoot),
      revocationAndUnknownChildDenied: Boolean(dispatcherRoot),
      liveModeBridgesProven: false, liveGuiMigrationProven: false }));
  } catch {
    console.error(JSON.stringify({ format: 'code-ai-native-shared-mode-contract', nativeVersion,
      synthetic: true, installedEffects: false, realProviderCalls: 0, failed: true, passed,
      loopbackFakeProviderCalls: requests, toolAdvertised, lastRpc, fullAccess, unannotated, codeMode, latePermissions, restorePermissions, brokerEnabled, serverRequests, nativeRejections })); process.exitCode = 1;
  } finally {
    for (const client of clients) client.terminate();
    if (owner.pid && owner.exitCode === null) {
      try { process.kill(-owner.pid, 'SIGTERM'); } catch { /* Own marked synthetic fixture only. */ }
      await Promise.race([once(owner, 'close'), new Promise(resolve => setTimeout(resolve, 2000))]);
      if (owner.exitCode === null && owner.signalCode === null) {
        try { process.kill(-owner.pid, 'SIGKILL'); } catch { /* Own marked synthetic fixture only. */ }
      }
    }
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    if (modeBridge) await modeBridge.close();
    await rm(root, { recursive: true, force: true });
  }
}
