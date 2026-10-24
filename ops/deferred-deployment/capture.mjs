import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, lstat, chmod, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Source capture only. This program never starts or installs a service, reads
// live credential files/environ, runs a compiler, or points a candidate at live
// persistent state. Protected accepted source/config remains byte-preserved;
// this exclusion is not a blanket claim that historical source is secret-free.
const ROOT = '/root/projects/code-ai';
const COMMON = '/mnt/hdd/code-ai-builds/drafts-panel-corrected-YkVl4c/payload';
const BASE = '/mnt/hdd/code-ai-builds/chrome-profile-edit-source-toedNZ';
const QUESTIONS = '/mnt/hdd/code-ai-builds/codex-interactive-source-OqYt26';
const SOURCE_TOP_LEVEL = ['client', 'server', 'shared', 'scripts', 'skills', 'chrome-extension',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'];
// Unneeded credential-bearing historical bootstrap/live-test scripts are not
// part of this isolated audit. Exclusion changes no accepted or installed tree.
const AUDIT_EXCLUDED_SOURCE_PATHS = [
  'scripts/personal-computer-agent.mjs', 'scripts/remote-host-deploy.mjs',
  'scripts/draft-api-smoke.mjs', 'scripts/windows-release-smoke.ps1',
  'scripts/workbench-visual-e2e.py', 'scripts/ux-mode-visual-e2e.py',
  'scripts/flow-mode-visual-e2e.py', 'scripts/design-mode-visual-e2e.py',
];
const IDENTITIES = {
  baseline: 'd670571c13f037be4b726996b7495cd2a2cebaf4e1847e775d5a6c45692842da',
  questions: '18d6627861778f5edb1d099e57d39968496656af9dcc91a252850e191de970bb',
};
const MAIN_SHA = '240e9f7e6a5b14a8e0754134cb1b448e051e6580bab0ddafb751bf9a381b07c7';
const BASE_SERVER_SHA = '0a958585a2a8c787f3c410b0ff952a4f293a680c15be85833d7b2f3daeef5c01';
// Full diffs of these four scoped paths were reviewed against the immutable
// accepted baseline. A later edit needs a fresh review, never an implicit copy.
const REVIEWED_CRITICAL_SOURCE = {
  'server/agentService.ts': '0e9ac5e1e88b7da5af40e26b77409274d7346169e26aa8e75672532b3067b111',
  'server/codexTerminal.ts': '0bbad3cc96ed91f2451f59846de81307d51dff70b6daa6952c389d87a649e13a',
  'server/codexQueue.ts': 'fccfa6e4263657a675ce97465f7a0054a6e52597ad4fcb1b8c67fc72c1dc099b',
  'server/index.ts': '4f8755eaa7b934307cd43c1b0902a627003fbb910712efc34603bb67df1915bb',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = filename => readFile(filename);
const text = async filename => (await read(filename)).toString('utf8');

/** Audit-only replacement of two bounded AST literal spans; never a live auth edit. */
export function sanitizeAuditConfig(source) {
  const ast = ts.createSourceFile('config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length, 0, 'Audit config source is not syntactically bounded');
  const definitions = new Map([
    ['deviceAdminPassword', { envField: 'CODEX_DEVICE_ADMIN_PASSWORD', synthetic: 'code-ai-offline-audit-device-admin-v1' }],
    ['sessionSecret', { envField: 'SESSION_SECRET', synthetic: 'code-ai-offline-audit-session-signing-v1' }],
  ]);
  const replacements = [];
  const privateOriginals = [];
  const seen = new Set();
  const sensitive = /password|secret|token|sign|auth|cookie|credential|key/i;
  const nonemptyLiterals = node => {
    const literals = [];
    function visit(value) {
      if ((ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && value.text.length) literals.push(value);
      ts.forEachChild(value, visit);
    }
    if (node) visit(node);
    return literals;
  };
  function visit(node) {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const field = node.name.text;
      if (definitions.has(field)) {
        assert.equal(seen.has(field), false, 'Sensitive audit field is not unique');
        const expected = definitions.get(field);
        const value = node.initializer;
        assert.ok(ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.BarBarToken
          && ts.isPropertyAccessExpression(value.left) && value.left.name.text === expected.envField
          && ts.isPropertyAccessExpression(value.left.expression) && value.left.expression.name.text === 'env'
          && ts.isIdentifier(value.left.expression.expression) && value.left.expression.expression.text === 'process'
          && ts.isStringLiteral(value.right) && value.right.text.length > 0,
        'Sensitive audit fallback shape changed; separate review required');
        seen.add(field);
        privateOriginals.push(value.right.text);
        replacements.push({ field, envField: expected.envField, start: value.right.getStart(ast), end: value.right.end,
          value: JSON.stringify(expected.synthetic) });
      } else if (sensitive.test(field)) {
        assert.equal(nonemptyLiterals(node.initializer).length, 0,
          'Additional sensitive source default requires separate bounded review');
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && sensitive.test(node.name.text)) {
      assert.equal(nonemptyLiterals(node.initializer).length, 0,
        'Sensitive source declaration requires separate bounded review');
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(seen.size, definitions.size, 'Sensitive audit default closure is incomplete');
  assert.equal(new Set(privateOriginals).size, definitions.size, 'Sensitive audit defaults are not independently bounded');
  for (const value of privateOriginals) assert.equal(source.split(value).length - 1, 1,
    'Sensitive source default has additional occurrences; separate review required');
  let sanitized = source;
  for (const change of [...replacements].sort((a, b) => b.start - a.start)) {
    sanitized = sanitized.slice(0, change.start) + change.value + sanitized.slice(change.end);
  }
  assert.equal(ts.createSourceFile('config.ts', sanitized, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS).parseDiagnostics.length,
    0, 'Synthetic audit config is not syntactically valid');
  const assertNoOriginalDefaults = value => {
    for (const original of privateOriginals) assert.equal(value.includes(original), false,
      'Known sensitive source default remains in the audit closure');
  };
  assertNoOriginalDefaults(sanitized);
  return {
    source: sanitized,
    assertNoOriginalDefaults,
    metadata: {
      file: 'server/config.ts', purpose: 'synthetic-nondeployable-audit-exception', productionLineagePreserved: false,
      installedOrAcceptedConfigChanged: false, liveCredentialReads: false,
      replacements: replacements.map(({ field, envField }) => ({ field, envField, count: 1, literalType: 'StringLiteral' })),
    },
  };
}

export function applyAcceptedUbuntuHistory(source) {
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, 'Accepted history integration anchor is not unique');
    source = source.replace(before, after);
  };
  replace("const SESSION_CATALOG_CACHE_VERSION = 'v3';", "const SESSION_CATALOG_CACHE_VERSION = 'v4';");
  replace("const SESSION_DETAIL_CACHE_VERSION = 'v4';", "const SESSION_DETAIL_CACHE_VERSION = 'v5';");
  const start = source.indexOf('async function buildSessionScanRows(');
  const end = source.indexOf('\nasync function scanSessionFiles(', start);
  assert.ok(start > 0 && end > start, 'Accepted history function boundary is absent');
  let scanner = source.slice(start, end);
  const scoped = (before, after) => {
    assert.equal(scanner.split(before).length, 2, 'Accepted scanner integration anchor is not unique');
    scanner = scanner.replace(before, after);
  };
  scoped('  const seen = new Set<string>();\n  const rows: SessionScanRecord[] = [];',
    '  const seen = new Set<string>();\n  const rowIndexById = new Map<string, number>();\n  const rows: SessionScanRecord[] = [];');
  scoped('            sourceSignature: `${stats.dev}:${stats.ino}:${stats.size}:${Math.trunc(stats.mtimeMs * 1_000)}`,',
    '            sourceSignature: `${stats.dev}:${stats.ino}:${stats.size}:${Math.trunc(stats.mtimeMs * 1_000)}`,\n            fileBytes: stats.size,');
  scoped('      for (const record of records) {\n        if (!record || seen.has(record.id)) continue;\n        seen.add(record.id);\n        rows.push(record);\n      }',
    '      for (const record of records) {\n        if (!record) continue;\n        const existingIndex = rowIndexById.get(record.id);\n        if (existingIndex === undefined) {\n          seen.add(record.id);\n          rowIndexById.set(record.id, rows.length);\n          rows.push(record);\n          continue;\n        }\n        const existing = rows[existingIndex]!;\n        if (\n          record.updatedAt > existing.updatedAt\n          || (record.updatedAt === existing.updatedAt && (record.fileBytes || 0) > (existing.fileBytes || 0))\n        ) {\n          rows[existingIndex] = record;\n        }\n      }');
  source = source.slice(0, start) + scanner + source.slice(end);
  replace('  sourceSignature?: string;\n}', '  sourceSignature?: string;\n  fileBytes?: number;\n}');
  assert.equal(/codexStoredHistory|storedHistories|history-db/.test(source), false,
    'Unqualified history projection entered the candidate');
  return source;
}

export function applyAcceptedUbuntuHistoryTest(source) {
  assert.equal(sha(source), '020ec12fabaf96e248a60b555b47b192a446f83e4e00b88b568c3f03be0c9133',
    'Accepted linked-history fixture changed; renewed baseline review required');
  const before = "const persistedPath = path.join(root, 'state', 'session-read-cache', 'v4', 'linked', sessionId, 'tail-120-before-latest.json');";
  const after = before.replace("'v4'", "'v5'");
  assert.equal(source.split(before).length, 2, 'Accepted linked-history cache expectation is not unique');
  const integrated = source.replace(before, after);
  assert.equal(integrated.replace(after, before), source, 'Linked-history assertions changed outside the accepted cache expectation');
  assert.equal(sha(integrated), 'bf404fe93e3db602d55ce671791f384caf5e5295f5c1cea777038b7d3c0f0b62',
    'Accepted linked-history test integration changed');
  return integrated;
}

export function applyQuestionHistoryAndDrain(source) {
  source = applyAcceptedUbuntuHistory(source);
  const replacements = [
    ["import { runCodexAppServerTurn, CodexAppServerCancelledError } from './codexAppServer.js';",
      "import { runCodexAppServerTurn, CodexAppServerCancelledError } from './codexAppServer.js';\nimport { registerCodexDeploymentDrainParticipant } from './codexDeploymentDrain.mjs';"],
    ['const activeCodexRuns = new Map<string, ActiveCodexRun>();',
      "const activeCodexRuns = new Map<string, ActiveCodexRun>();\nregisterCodexDeploymentDrainParticipant('native-codex', () => ({\n  ready: true,\n  active: activeCodexRuns.size,\n}));"],
  ];
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length, 2, 'Native drain integration anchor is not unique');
    source = source.replace(before, after);
  }
  return source;
}

export function applyDeploymentRetryUi(source) {
  const replacements = [
    ["import { interleaveUserInput } from './userInputTimeline';",
      "import { interleaveUserInput } from './userInputTimeline';\nimport { fetchWithDeploymentRetry } from './deploymentRetry';"],
    ['async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {\n  const response = await codexFetch(input, init);',
      'async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {\n  // Pin the selected host for the whole retry, even if navigation changes it.\n  const requestServerId = activeCodeAiServerId || LOCAL_SERVER_ID;\n  const response = await fetchWithDeploymentRetry((request, options) => codexFetch(request, options, requestServerId), input, init);'],
    ['  const response = await codexFetch(input, init, serverId);',
      '  const response = await fetchWithDeploymentRetry((request, options) => codexFetch(request, options, serverId), input, init);'],
  ];
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length, 2, 'UI deployment retry anchor is not unique');
    source = source.replace(before, after);
  }
  return source;
}

function safeRelative(name) {
  assert.ok(typeof name === 'string' && name.length > 0 && !path.isAbsolute(name)
    && !name.split('/').includes('..') && !name.includes('\\'), 'Invalid reviewed source path');
  assert.equal(/(^|\/)(?:\.env(?:\..*)?|\.code-ai|\.codex|node_modules|dist|auth\.json|pairing\.json)(?:\/|$)/.test(name),
    false, 'Runtime state or credential path is outside the source capture');
  return name;
}

async function inventory(root) {
  const result = {};
  async function visit(relative) {
    safeRelative(relative);
    const filename = path.join(root, relative);
    const stat = await lstat(filename);
    if (stat.isSymbolicLink()) {
      // No source link may resolve to live state or out of the capture tree.
      const target = await readlink(filename);
      assert.ok(!path.isAbsolute(target), 'Absolute source symlink is not supported');
      const resolved = path.resolve(path.dirname(filename), target);
      assert.ok(resolved.startsWith(root + path.sep), 'Source symlink escapes its capture');
      result[relative] = { type: 'symlink', sha256: sha(target), mode: stat.mode & 0o777 };
    } else if (stat.isDirectory()) {
      for (const child of (await readdir(filename)).sort()) await visit(path.join(relative, child));
    } else {
      assert.ok(stat.isFile(), 'Non-file source entry is unsupported');
      result[relative] = { type: 'file', sha256: sha(await read(filename)), mode: stat.mode & 0o777 };
    }
  }
  for (const entry of SOURCE_TOP_LEVEL) await visit(entry);
  return result;
}

const permittedCurrentOverlay = name => [
  'server/agentService.ts', 'server/codexTerminal.ts', 'server/codexTerminal.test.ts',
  'server/index.ts', 'server/codexQueue.ts', 'server/codexQueue.drafts.test.ts',
  'server/codexAppServer.ts', 'server/codexAppServer.test.ts',
  'server/codexUserInput.ts', 'server/codexUserInput.test.ts',
  'server/codexSharedSubmission.mjs', 'server/codexSharedSubmission.test.mjs',
  'scripts/codex-shared-stdio.mjs', 'scripts/codex-shared-stdio.test.mjs',
  'scripts/codex-writer-contract.mjs', 'scripts/codex-shared-writer-contract.mjs',
  'client/src/components/codex/deploymentRetry.ts', 'client/src/components/codex/deploymentRetry.test.ts',
].includes(name) || /^server\/codexDeploymentDrain(?:[.][A-Za-z0-9_-]+)*[.](?:mjs|ts)$/.test(name)
  || /^server\/codexQueue[.](?:deployment|drain)[.].*[.]test[.]ts$/.test(name)
  || /^scripts\/codex-shared-owner(?:[.][A-Za-z0-9_-]+)*[.]mjs$/.test(name);

async function checkedOverlay(entry, sourceRoot = ROOT) {
  const relative = safeRelative(entry.path);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/, 'Frozen source digest is required');
  const bytes = await read(path.join(sourceRoot, relative));
  assert.equal(sha(bytes), entry.sha256, 'A reviewed source stream changed after freeze');
  return [relative, bytes];
}

async function main(argv) {
  const preflight = argv.includes('--preflight');
  const at = argv.indexOf('--overlay-manifest');
  assert.ok(at >= 0 && argv[at + 1], 'An explicit reviewed overlay manifest is required');
  const manifestPath = path.resolve(argv[at + 1]);
  const manifestBytes = await read(manifestPath);
  const freeze = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(freeze.format, 'code-ai-deferred-source-freeze');
  assert.equal(freeze.version, 1);
  assert.equal(freeze.streamsComplete, true, 'Source streams are not frozen');
  assert.equal(freeze.purpose, 'nondeployable-offline-contract-audit', 'This capture is evidence-only, not a deployment candidate');
  assert.equal(freeze.productionReady, false, 'Unclosed production contracts prohibit a deployable capture');
  assert.ok(Array.isArray(freeze.overlays) && Array.isArray(freeze.qualificationFiles));
  assert.equal(sha(await read(BASE + '/source-identity.json')), IDENTITIES.baseline);
  assert.equal(sha(await read(QUESTIONS + '/source-identity.json')), IDENTITIES.questions);
  assert.equal(sha(await read(ROOT + '/dist/server.js')), MAIN_SHA,
    'Main accepted runtime advanced; rebase onto the new accepted lineage');
  assert.equal(sha(await read('/mnt/hdd/code-ai-builds/chrome-profile-edit-imports/80c8c7bf-871c-4f7b-b1c5-67cce4e024a8/artifact/dist/server.js')),
    BASE_SERVER_SHA, 'Accepted Ubuntu baseline artifact changed');
  const baselineBefore = await inventory(BASE + '/payload');
  const syntheticConfig = sanitizeAuditConfig(await text(BASE + '/payload/server/config.ts'));
  for (const relative of AUDIT_EXCLUDED_SOURCE_PATHS) assert.ok(baselineBefore[relative],
    'A declared audit-only exclusion requires renewed source review');
  // Private comparison only. Additional copies of the known source defaults
  // stop capture; no values, raw lines or assertion operands are reported.
  for (const [relative, entry] of Object.entries(baselineBefore)) {
    if (entry.type === 'file' && relative !== 'server/config.ts') {
      syntheticConfig.assertNoOriginalDefaults(await text(path.join(BASE, 'payload', relative)));
    }
  }
  const questionIdentity = JSON.parse(await text(QUESTIONS + '/source-identity.json'));
  const contents = new Map();
  for (const relative of questionIdentity.changedPaths) {
    if (relative === 'server/codexService.ts' || relative.endsWith('/CodexMobileApp.tsx')) continue;
    const bytes = await read(path.join(QUESTIONS, 'payload', safeRelative(relative)));
    assert.equal(sha(bytes), questionIdentity.sourceHashes[relative], 'Frozen question feature changed');
    contents.set(relative, bytes);
  }
  const appPath = 'client/src/components/codex/CodexMobileApp.tsx';
  const merged = spawnSync('git', ['merge-file', '-p', path.join(QUESTIONS, 'payload', appPath),
    path.join(COMMON, appPath), path.join(BASE, 'payload', appPath)], { encoding: 'buffer', maxBuffer: 3_000_000 });
  assert.equal(merged.status, 0, 'Chrome profile and native questions need semantic UI integration');
  assert.equal(sha(merged.stdout), '596d66216efcb49ef88c6f77698d4b0f0b737fd43a9b7a82f55a940bb816cd9a',
    'Accepted feature UI merge changed');
  const retryUi = applyDeploymentRetryUi(merged.stdout.toString('utf8'));
  assert.equal(sha(retryUi), sha(await read(ROOT + '/' + appPath)),
    'Current UI includes a delta outside the accepted merge and three retry hunks');
  contents.set(appPath, Buffer.from(retryUi));
  const historicService = applyAcceptedUbuntuHistory(await text(QUESTIONS + '/payload/server/codexService.ts'));
  let service = applyQuestionHistoryAndDrain(await text(QUESTIONS + '/payload/server/codexService.ts'));
  if (freeze.serviceIntegration) {
    assert.ok(path.isAbsolute(freeze.serviceIntegration.path), 'Integrated service requires an exact private source path');
    service = await text(freeze.serviceIntegration.path);
    assert.equal(sha(service), freeze.serviceIntegration.sha256, 'Integrated service changed after freeze');
    assert.equal(sha(service), 'da51f4af239a22b46c739190b9ffa924f2da9bb8fc4f46c20ee7294bbcfa8e4c',
      'Integrated service execution delta has not passed its scoped baseline review');
    const scanner = value => value.slice(value.indexOf('async function buildSessionScanRows('),
      value.indexOf('\nasync function scanSessionFiles(', value.indexOf('async function buildSessionScanRows(')));
    assert.equal(scanner(service), scanner(historicService), 'Accepted Ubuntu history scanner was not preserved');
    assert.ok(service.includes("const SESSION_CATALOG_CACHE_VERSION = 'v4';")
      && service.includes("const SESSION_DETAIL_CACHE_VERSION = 'v5';"), 'Accepted history cache generations changed');
    assert.equal(/codexStoredHistory|storedHistories|history-db|requireOriginalSessionRecord/.test(service), false,
      'Unqualified history projection entered the candidate');
    assert.ok(Array.isArray(freeze.serviceIntegration.reviewedChangedContracts)
      && freeze.serviceIntegration.reviewedChangedContracts.length > 0, 'Service changes require an explicit contract review');
  }
  contents.set('server/codexService.ts', Buffer.from(service));
  const acceptedHistoryTestPath = 'server/codexSessionFiles.test.ts';
  contents.set(acceptedHistoryTestPath, Buffer.from(applyAcceptedUbuntuHistoryTest(
    await text(path.join(BASE, 'payload', acceptedHistoryTestPath)))));
  for (const entry of freeze.overlays) {
    assert.ok(permittedCurrentOverlay(entry.path), 'Source path is outside the named release closure');
    const [relative, bytes] = await checkedOverlay(entry);
    if (Object.hasOwn(REVIEWED_CRITICAL_SOURCE, relative)) assert.equal(sha(bytes), REVIEWED_CRITICAL_SOURCE[relative],
      'Critical source changed after its accepted-baseline delta audit; fresh review required');
    contents.set(relative, bytes);
  }
  for (const p of ['client/src/components/codex/deploymentRetry.ts',
    'client/src/components/codex/deploymentRetry.test.ts']) assert.ok(contents.has(p), 'UI retry helper closure is incomplete');
  const protectedPaths = ['server/config.ts', 'server/personalChromeBridge.ts', 'server/personalChromeProtocol.ts',
    'client/src/components/codex/PersonalChromeModeDialog.tsx',
    'client/src/components/codex/PersonalChromeProfileEditor.tsx', 'client/src/components/codex/personalChromeProfile.ts'];
  for (const p of protectedPaths) assert.equal(contents.has(p), false, 'Protected accepted source was overwritten');
  // This is the sole named synthetic exception to protected-source lineage.
  // Do not copy the original config even transiently into the new audit stage.
  contents.set('server/config.ts', Buffer.from(syntheticConfig.source));
  for (const relative of AUDIT_EXCLUDED_SOURCE_PATHS) assert.equal(contents.has(relative), false,
    'Excluded historical live tool entered the named audit overlay closure');
  const wrapper = new Map();
  for (const entry of freeze.qualificationFiles) {
    assert.ok(['package.json', 'pnpm-lock.yaml', 'test.mjs', 'build.mjs', 'fake-codex.mjs',
      'api-smoke.mjs', 'drain-smoke.mjs', 'drain-audit-smoke.mjs', 'coordinator.mjs', 'coordinator.test.mjs', 'coordinator-audit.test.mjs',
      'controller-client.mjs', 'bootstrap-inspector-contract.mjs',
      'systemd/render-units.mjs'].includes(entry.path), 'Unreviewed build wrapper file');
    const [relative, bytes] = await checkedOverlay(entry, ROOT + '/ops/deferred-deployment');
    wrapper.set(relative, bytes);
  }
  for (const p of ['package.json', 'pnpm-lock.yaml', 'test.mjs', 'build.mjs']) assert.ok(wrapper.has(p));
  for (const bytes of [...contents.values(), ...wrapper.values()]) syntheticConfig.assertNoOriginalDefaults(bytes.toString('utf8'));
  const evidence = {
    format: 'code-ai-cumulative-deferred-source-capture', version: 1,
    capturedAt: new Date().toISOString(), installedEffects: false, productionReady: false,
    purpose: 'nondeployable-offline-contract-audit', deploymentArtifact: false,
    artifactExportAllowed: 'qualification metadata only; no runnable application distribution',
    baselineBuildId: '80c8c7bf-871c-4f7b-b1c5-67cce4e024a8',
    commonBaselineBuildId: '74ee3eaf-de92-4f53-be0b-c0a1e46fa1be',
    questionBuildId: '7e837f6f-708d-498b-835d-f4bcb3453a78',
    acceptedUbuntuHistoryServerSha256: '404457832dfc997adef4b42fdf959ab4c9105e906e06f50339ee9d00db8dc3a6',
    acceptedHistoryTestIntegration: {
      file: acceptedHistoryTestPath, source: 'immutable-accepted-baseline-only', currentWorktreeCopied: false,
      beforeSha256: '020ec12fabaf96e248a60b555b47b192a446f83e4e00b88b568c3f03be0c9133',
      afterSha256: 'bf404fe93e3db602d55ce671791f384caf5e5295f5c1cea777038b7d3c0f0b62',
      persistedCacheExpectation: 'v4-to-v5', replacementCount: 1, allOtherFixtureAssertionsPreserved: true,
    },
    sourceFreezeSha256: sha(manifestBytes), sourceBaselineTreeSha256: sha(JSON.stringify(baselineBefore)),
    changedPaths: [...contents.keys(), ...AUDIT_EXCLUDED_SOURCE_PATHS].sort(),
    sourceHashes: Object.fromEntries([...contents].map(([relative, bytes]) => [relative, sha(bytes)])),
    qualificationHashes: Object.fromEntries([...wrapper].map(([relative, bytes]) => [relative, sha(bytes)])),
    protectedPaths, syntheticConfigException: syntheticConfig.metadata,
    excludedSourceScripts: AUDIT_EXCLUDED_SOURCE_PATHS.map(file => ({ file,
      action: 'excluded-from-audit-only', reason: 'unneeded-credential-bearing-historical-live-tool',
      installedOrAcceptedSourceChanged: false })),
    retention: 'nondeployable-audit-only; preserve all installed rollback releases',
    reviewedCriticalSource: REVIEWED_CRITICAL_SOURCE,
    constructedServiceHistoryAndDrainOnly: !freeze.serviceIntegration,
    uiIntegration: 'accepted conflict-free feature merge plus exact import and two retry wrappers only',
    preservedVariants: { main: MAIN_SHA, beamAndPci: '4c83ae10e25641a53475312e8cf2e38d0396533bb892b8ce04810b48deaef9e9',
      ubuntu: '79d8cd2292b6d420720f0aa5e2976d3d82bea8e22865501ca5a6dbc081c8ed1f', windows: 'offline-unverified' },
    remainingGates: ['BEAM complete application qualification and fresh attested import',
      'Exact installed singleton bootstrap fence and drain acceptance',
      'Shared-owner migration/native GUI/IDE/Windows closure where requested', 'Post-activation scoped business readback'],
  };
  if (preflight) {
    assert.deepEqual(await inventory(BASE + '/payload'), baselineBefore, 'Accepted source changed during preflight');
    console.log(JSON.stringify({ preflight: true, changedPaths: evidence.changedPaths,
      sourceFreezeSha256: evidence.sourceFreezeSha256, productionReady: false, installedEffects: false,
      purpose: evidence.purpose, deploymentArtifact: false,
      syntheticConfigException: syntheticConfig.metadata, excludedSourceScripts: evidence.excludedSourceScripts }));
    return;
  }
  const stage = await mkdtemp('/mnt/hdd/code-ai-builds/deferred-deployment-source-');
  await chmod(stage, 0o700);
  await mkdir(stage + '/payload');
  for (const entry of SOURCE_TOP_LEVEL) await cp(path.join(BASE, 'payload', entry), path.join(stage, 'payload', entry),
    { recursive: true, verbatimSymlinks: true, filter: source => {
      const relative = path.relative(path.join(BASE, 'payload'), source);
      return relative !== 'server/config.ts' && !AUDIT_EXCLUDED_SOURCE_PATHS.includes(relative);
    } });
  for (const [relative, bytes] of contents) {
    await mkdir(path.dirname(path.join(stage, 'payload', relative)), { recursive: true });
    await writeFile(path.join(stage, 'payload', relative), bytes);
  }
  for (const [relative, bytes] of wrapper) {
    await mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
    await writeFile(path.join(stage, relative), bytes);
  }
  const captured = await inventory(stage + '/payload');
  for (const [relative, entry] of Object.entries(captured)) {
    if (entry.type === 'file') syntheticConfig.assertNoOriginalDefaults(await text(path.join(stage, 'payload', relative)));
  }
  for (const [relative, baseline] of Object.entries(baselineBefore)) {
    if (!contents.has(relative) && !AUDIT_EXCLUDED_SOURCE_PATHS.includes(relative)) assert.deepEqual(captured[relative], baseline,
      'A source path outside the reviewed release closure changed');
  }
  for (const relative of Object.keys(captured)) {
    assert.ok(baselineBefore[relative] || contents.has(relative), 'Unexpected source path entered the capture');
  }
  assert.deepEqual(await inventory(BASE + '/payload'), baselineBefore, 'Accepted source changed during capture');
  assert.equal(sha(await read(ROOT + '/dist/server.js')), MAIN_SHA, 'Main accepted runtime advanced during capture');
  evidence.preservedOutsideDeclaredAuditExceptions = true;
  evidence.capturedTreeSha256 = sha(JSON.stringify(captured));
  await writeFile(stage + '/source-identity.json', JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ stage, changedPaths: contents.size, capturedTreeSha256: evidence.capturedTreeSha256,
    preservedOutsideDeclaredAuditExceptions: true, productionReady: false, installedEffects: false,
    purpose: evidence.purpose, deploymentArtifact: false }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => {
    // Assertion operands, source excerpts and subprocess stdout are not safe logs.
    console.error(JSON.stringify({ captureFailed: true, code: error.code || 'SOURCE_PREFLIGHT_FAILED',
      message: String(error.message || 'Source preflight failed').split('\n')[0] }));
    process.exitCode = 1;
  });
}
