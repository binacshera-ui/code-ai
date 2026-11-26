/** Local HTTP contract tests: the production Express router and message handler
 * are real; provider, queue and metadata stores are strict synthetic boundaries.
 * No native owner, user session, production file or paid model is contacted.
 * Run directly: node --test server/codexLiveMessages.routes.test.mjs
 */
import assert from 'node:assert/strict';
import test, { before, beforeEach, after } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { build } from 'esbuild';
import ts from 'typescript';
import { createCodexDeploymentHttpTracker } from './codexDeploymentDrain.mjs';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(serverRoot);
const routeFile = path.join(serverRoot, 'codexRoutes.ts');
const globalKey = 'code-ai-live-message-routes-' + randomUUID();
let scratch, listener, base, state;

function reset() {
  state.live = 'delivered';
  state.appended = []; state.enqueued = []; state.lookups = [];
  state.contextReads = []; state.contextDeletes = [];
  state.records = new Map();
  state.extension = 'denied';
}

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'code-ai-live-message-routes-'));
  await symlink(path.join(projectRoot, 'node_modules'), path.join(scratch, 'node_modules'));
  state = { uploadRoot: path.join(scratch, 'uploads') }; reset();
  const profiles = ['fixture', 'other-provider'].map(id => ({ id, label: id, provider: id === 'fixture' ? 'codex' : 'claude',
    codexHome: path.join(scratch, id), workspaceCwd: scratch, mode: 'standard', defaultProfile: id === 'fixture' }));
  const dependencies = {
    CODEX_APP_CONFIG: { profiles, defaultProfileId: 'fixture', storageRoot: scratch, uploadRoot: state.uploadRoot,
      workspaceRoot: scratch, publicHosts: ['public.fixture'], openAccess: false, deviceAdminPassword: '',
      sessionSecret: 'synthetic-fixture-secret-only' },
    CODEX_UPLOAD_ROOT: state.uploadRoot,
    CLIENT_CRASH_LOG: path.join(scratch, 'synthetic-crashes.jsonl'),
    createServerStatusRouter: () => express.Router(),
    createWorkModeRouter: () => express.Router(),
    createSessionDecisionBoardRouter: () => express.Router(),
    createIncidentDecisionCenterService: () => ({}),
    SessionReadReceiptStore: class {},
    resolveCodexQueueSessionId: async () => null,
    getAgentSessionLinkForSession: async () => null,
    getAgentSessionDetail: async () => ({ cwd: scratch }),
    resolveCodexFolderPath: async value => ({ resolvedPath: value }),
    getForkDraftSession: async () => null,
    isSupportProfile: () => false,
    buildSessionPromptAdditionsContext: async () => null,
    getSessionContextSelection: async (...args) => {
      state.contextReads.push(args);
      return { anchorIds: [], skillIds: [], reminderIds: [], agentSessionDraftId: null,
        professionalMode: false, annotationsMode: false, goalMode: false, actionRestriction: null };
    },
    deleteSessionContextSelection: async (...args) => { state.contextDeletes.push(args); },
    readPersonalChromeUiCredentials: req => req.headers['x-fixture-extension']
      ? { deviceId: 'synthetic-device', token: 'synthetic-token-only' } : null,
    authenticatePersonalChromeUiToken: async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (state.extension === 'error') throw Error('Synthetic extension lookup failed');
      if (state.extension === 'denied') return null;
      return { authenticated: true, deviceUnlocked: true, user: { id: 'synthetic-extension-user' } };
    },
    findCodexQueueRequest: async (profileId, requestId) => {
      state.lookups.push({ profileId, requestId });
      return state.records.get(JSON.stringify([profileId, requestId])) || null;
    },
    enqueueCodexQueueItem: async value => {
      state.enqueued.push(structuredClone(value));
      const item = { ...structuredClone(value), id: 'fixture-queue-' + state.enqueued.length,
        status: value.saveAsDraft ? 'draft' : 'queued' };
      if (value.clientRequestId) state.records.set(JSON.stringify([value.profileId, value.clientRequestId]), item);
      return item;
    },
    appendCodexLiveMessage: async value => {
      state.appended.push(structuredClone(value));
      if (state.live === 'idle') return null;
      if (state.live === 'ended') throw Object.assign(new Error('Synthetic active turn ended'), {
        statusCode: 409, code: 'LIVE_TURN_ENDED',
      });
      if (state.live === 'unsupported') throw Object.assign(new Error('Synthetic live capability unavailable'), {
        statusCode: 503, code: 'LIVE_INPUT_UNAVAILABLE',
      });
      return { id: 'fixture-live-' + value.clientRequestId, profileId: value.profileId,
        sessionId: value.sessionId, clientRequestId: value.clientRequestId,
        turnId: 'fixture-active-turn', status: 'delivered', kind: 'active-turn' };
    },
  };
  for (const name of ['Browser', 'Design', 'Ux', 'Project', 'PersonalChrome', 'Phone']) {
    dependencies['getSession' + name + 'ModeRecord'] = async () => null;
  }
  globalThis[Symbol.for(globalKey)] = {
    get(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      return () => { throw new Error('Unexpected service boundary invoked: ' + name); };
    },
  };

  const source = await readFile(routeFile, 'utf8');
  const syntax = ts.createSourceFile(routeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Map();
  for (const node of syntax.statements) {
    if (!ts.isImportDeclaration(node) || !node.moduleSpecifier.text.startsWith('.') || node.importClause?.isTypeOnly) continue;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) throw Error('Unsupported route import shape in fixture');
    const entries = [...(imports.get(node.moduleSpecifier.text) || []), ...bindings.elements.filter(element => !element.isTypeOnly)
      .map(element => ({ local: element.name.text, imported: (element.propertyName || element.name).text }))];
    imports.set(node.moduleSpecifier.text, [...new Map(entries.map(entry => [entry.imported, entry])).values()]);
  }
  // Exercise the actual attachment formatter and inline-image predicate without
  // initializing codexService's unrelated runtime services. No implementation is
  // duplicated: the existing function declaration is selected from its AST.
  const serviceFile = path.join(serverRoot, 'codexService.ts');
  const serviceSource = await readFile(serviceFile, 'utf8');
  const serviceSyntax = ts.createSourceFile(serviceFile, serviceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const formatter = serviceSyntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildPromptWithAttachments');
  assert.ok(formatter, 'production attachment formatter must exist');

  const outfile = path.join(scratch, 'routes.mjs');
  await build({ entryPoints: [routeFile], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolated-route-service-boundaries', setup(builder) {
      builder.onResolve({ filter: /^\./ }, args => {
        if (args.importer !== routeFile || ['./codexMessageAdmission.mjs', './codexUploads.js', './fileNameNormalizer.js'].includes(args.path)) return;
        assert.ok(imports.has(args.path), 'every direct boundary must be an actual route import');
        return { path: args.path, namespace: 'route-fixture-boundary' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'route-fixture-boundary' }, args => {
        const entries = imports.get(args.path);
        const actualFormatter = args.path === './codexService.js';
        const header = `const fixture = globalThis[Symbol.for(${JSON.stringify(globalKey)})];`;
        const exports = entries.filter(entry => !(actualFormatter && entry.imported === 'buildPromptWithAttachments'))
          .map(entry => `export const ${entry.imported} = fixture.get(${JSON.stringify(entry.imported)});`).join('\n');
        const contents = actualFormatter
          ? `import path from 'node:path'; import { isCodexInlineImage } from ${JSON.stringify(path.join(serverRoot, 'codexAttachmentInputs.ts'))};\n${header}\n${exports}\n${formatter.getText(serviceSyntax)}`
          : header + '\n' + exports;
        return { contents, loader: 'ts', resolveDir: serverRoot };
      });
    } }],
  });
  const { default: router } = await import(pathToFileURL(outfile).href);
  const tickets = new Set();
  const tracker = createCodexDeploymentHttpTracker({
    registerParticipant() {},
    // Match the real passive upload process's asynchronously acknowledged
    // owner admission, rather than bypassing the tracker with a sync ticket.
    async acquireHttpAdmission() {
      const ticket = { release() { tickets.delete(ticket); } };
      tickets.add(ticket); return ticket;
    },
  });
  state.tracker = tracker; state.peerTickets = tickets;
  tracker.wrapHandlers(router);
  const app = express(); app.use(express.json()); app.use(tracker.middleware);
  // Authenticate synthetic requests through the route's existing remote-agent
  // access branch; this does not change authentication on any real app.
  app.use((req, _res, next) => {
    if (!req.headers['x-fixture-auth-check']) req.codeAiRemoteAgentAuthenticated = true;
    next();
  });
  app.use('/api/codex', router);
  listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  base = `http://127.0.0.1:${listener.address().port}/api/codex`;
});
beforeEach(() => reset());
after(async () => {
  listener?.closeAllConnections(); listener?.close();
  delete globalThis[Symbol.for(globalKey)];
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const body = (extra = {}) => ({ profileId: 'fixture', sessionId: 'synthetic-session', queueKey: 'synthetic-session',
  clientRequestId: 'fixture-request', prompt: 'A synthetic follow-up', ...extra });
const post = (value, route = '/messages') => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});

async function assertHttpSettled() {
  // finish/close may precede the tracked async handler's final microtask.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.tracker.getActiveCount(), 0, 'A completed response must not leak an HTTP drain admission');
  assert.equal(state.peerTickets.size, 0, 'The passive owner admission must be released exactly once');
}

test('active delivery returns its native receipt without enqueueing, consuming context or mutating execution settings', async () => {
  const response = await post(body({ model: 'different-model', reasoningEffort: 'max', permissionModeId: 'full',
    serviceTier: 'ultrafast', cwd: '/fixture/requested-directory', actionRestriction: { enabled: true } }));
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.delivery.kind, 'active-turn');
  assert.equal(result.delivery.clientRequestId, 'fixture-request'); assert.equal(result.item, undefined);
  assert.notEqual(result.delivery.id, result.delivery.clientRequestId, 'internal receipt ID is not the request correlation ID');
  assert.equal(state.enqueued.length, 0); assert.equal(state.contextReads.length, 0); assert.equal(state.contextDeletes.length, 0);
  assert.deepEqual(state.appended, [{ profileId: 'fixture', sessionId: 'synthetic-session', clientRequestId: 'fixture-request',
    input: [{ type: 'text', text: 'A synthetic follow-up' }], contextText: 'A synthetic follow-up' }]);
});

test('idle existing and new conversations retain the regular queue path', async () => {
  state.live = 'idle';
  const idle = await post(body()); assert.equal(idle.status, 202);
  assert.equal((await idle.json()).item.status, 'queued');
  assert.equal(state.appended.length, 1); assert.equal(state.enqueued.length, 1);
  const fresh = await post(body({ sessionId: undefined, queueKey: 'draft:new-tab', clientRequestId: 'new-request' }));
  assert.equal(fresh.status, 202); assert.equal((await fresh.json()).item.status, 'queued');
  assert.equal(state.appended.length, 1, 'a new conversation must not probe a live turn');
  assert.equal(state.enqueued.length, 2);
});

test('saved drafts bypass live input and preserve the existing non-running draft behavior', async () => {
  for (const [route, extra] of [['/messages', { saveAsDraft: true }], ['/queue/drafts', {}]]) {
    const response = await post(body({ ...extra, clientRequestId: 'draft-' + route.replaceAll('/', '-') }), route);
    assert.equal(response.status, 201); assert.equal((await response.json()).item.status, 'draft');
  }
  assert.equal(state.appended.length, 0); assert.equal(state.enqueued.length, 2);
  assert.ok(state.enqueued.every(item => item.saveAsDraft === true));
  assert.equal(state.contextReads.length, 0); assert.equal(state.contextDeletes.length, 0);
});

test('future and past schedules, recurrence and the legacy queue endpoint never enter live delivery', async () => {
  const scenarios = [
    { scheduledAt: '2999-01-01T00:00:00.000Z' },
    { scheduledAt: '2000-01-01T00:00:00.000Z' },
    { recurrence: { frequency: 'daily', timeZone: 'UTC' } },
  ];
  for (const [index, extra] of scenarios.entries()) {
    const response = await post(body({ ...extra, clientRequestId: 'scheduled-' + index }));
    assert.equal(response.status, 202); const { item } = await response.json();
    if (extra.scheduledAt) assert.equal(item.scheduledAt, extra.scheduledAt);
    if (extra.recurrence) assert.deepEqual(item.recurrence, extra.recurrence);
  }
  assert.equal((await post(body({ clientRequestId: 'legacy-only' }), '/queue/items')).status, 202);
  assert.equal(state.appended.length, 0); assert.equal(state.enqueued.length, 4);
});

test('a retry with the same legacy queue request ID returns the original acknowledgement without live append or duplicate enqueue', async () => {
  const first = await post(body(), '/queue/items'); assert.equal(first.status, 202);
  const original = (await first.json()).item;
  const retried = await post(body()); assert.equal(retried.status, 202);
  assert.deepEqual((await retried.json()).item, original);
  assert.equal(state.enqueued.length, 1); assert.equal(state.appended.length, 0);
  assert.deepEqual(state.lookups, [{ profileId: 'fixture', requestId: 'fixture-request' }]);
});

test('an active-turn compare-and-swap rejection is returned as an error and never falls through to the queue', async () => {
  state.live = 'ended';
  const response = await post(body()); assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'LIVE_TURN_ENDED');
  assert.equal(state.appended.length, 1); assert.equal(state.enqueued.length, 0);
});

test('unsupported live transport returns 503 rather than silently scheduling the message for later', async () => {
  state.live = 'unsupported';
  const response = await post(body()); assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'LIVE_INPUT_UNAVAILABLE');
  assert.equal(state.appended.length, 1); assert.equal(state.enqueued.length, 0);
});

test('image/audio/file attachments remain available while only supported image payloads become localImage inputs', async () => {
  const attachments = [
    { id: 'png', name: 'fixture.png', path: path.join(state.uploadRoot, 'fixture.png'), mimeType: 'image/png', isImage: true },
    { id: 'audio', name: 'fixture.wav', path: path.join(state.uploadRoot, 'fixture.wav'), mimeType: 'audio/wav', isImage: false },
    { id: 'svg', name: 'fixture.svg', path: path.join(state.uploadRoot, 'fixture.svg'), mimeType: 'image/svg+xml', isImage: true },
    { id: 'outside', name: 'outside.png', path: path.join(scratch, 'outside.png'), mimeType: 'image/png', isImage: true },
  ];
  const response = await post(body({ attachments })); assert.equal(response.status, 200);
  const request = state.appended[0];
  assert.deepEqual(request.input.filter(item => item.type === 'localImage'), [{ type: 'localImage', path: attachments[0].path }]);
  for (const attachment of attachments.slice(0, 3)) assert.ok(request.contextText.includes(attachment.path));
  assert.ok(!request.contextText.includes(attachments[3].path));
  assert.equal(request.contextText, request.input[0].text);
  assert.deepEqual(Object.keys(request).sort(), ['clientRequestId', 'contextText', 'input', 'profileId', 'sessionId']);
  assert.equal(state.enqueued.length, 0);
});

test('stable request IDs and a nonempty live message are validated before delivery or queue work', async () => {
  for (const clientRequestId of [undefined, '', 'contains whitespace']) {
    assert.equal((await post(body({ clientRequestId }))).status, 400);
  }
  assert.equal((await post(body({ prompt: '  ' }))).status, 400);
  assert.equal(state.appended.length, 0); assert.equal(state.enqueued.length, 0);
});

test('real access middleware settles denied 401 and locked-device 403 responses in the HTTP drain tracker', async () => {
  for (const [host, status] of [['private.fixture', 401], ['public.fixture', 403]]) {
    const response = await fetch(base + '/messages', { method: 'POST', headers: {
      host, 'x-forwarded-host': host, 'x-forwarded-for': '198.51.100.42', 'x-fixture-auth-check': '1', 'content-type': 'application/json',
    }, body: JSON.stringify(body()) });
    assert.equal(response.status, status); await response.text();
    await assertHttpSettled();
  }
  assert.equal(state.appended.length, 0); assert.equal(state.enqueued.length, 0);
});

test('the real extension authentication Promise settles denied, failed and accepted access without leaking admissions', async () => {
  for (const [scenario, status] of [['denied', 401], ['error', 500], ['accepted', 200]]) {
    state.extension = scenario;
    const response = await fetch(base + '/messages', { method: 'POST', headers: {
      host: 'private.fixture', 'x-forwarded-for': '198.51.100.42', 'x-fixture-auth-check': '1',
      'x-fixture-extension': '1', 'content-type': 'application/json',
    }, body: JSON.stringify(body({ clientRequestId: 'extension-' + scenario })) });
    assert.equal(response.status, status); await response.text();
    await assertHttpSettled();
  }
  assert.equal(state.appended.length, 1); assert.equal(state.enqueued.length, 0);
});

test('real upload middleware settles successful and rejected multipart receipts after its cleanup callback', async () => {
  const success = new FormData(); success.append('files', new Blob(['synthetic fixture bytes'], { type: 'text/plain' }), 'fixture.txt');
  const uploaded = await fetch(base + '/uploads', { method: 'POST', body: success });
  assert.equal(uploaded.status, 200); const result = await uploaded.json(); assert.equal(result.files.length, 1);
  assert.ok(result.files[0].path.startsWith(state.uploadRoot + path.sep)); await assertHttpSettled();
  const invalid = new FormData(); invalid.append('unexpected-field', new Blob(['synthetic only']), 'rejected.txt');
  const rejected = await fetch(base + '/uploads', { method: 'POST', body: invalid });
  assert.equal(rejected.status, 400); assert.equal((await rejected.json()).code, 'LIMIT_UNEXPECTED_FILE');
  await assertHttpSettled();
});
