import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { applyAcceptedUbuntuHistory } from './capture.mjs';

// Mechanical source integration, never an installed file or live CODEX_HOME.
// Keep the accepted questions service and only the separately accepted Ubuntu
// scanner/cache changes. Import the reviewed execution slice, not pending
// database history projections elsewhere in the dirty worktree.
const root = '/root/projects/code-ai';
const base = '/mnt/hdd/code-ai-builds/codex-interactive-source-OqYt26/payload/server/codexService.ts';
let integrated = applyAcceptedUbuntuHistory(await readFile(base, 'utf8'));
const current = await readFile(root + '/server/codexService.ts', 'utf8');
const startAnchor = 'export async function runCodexPrompt(';
assert.equal(integrated.split(startAnchor).length, 2);
assert.equal(current.split(startAnchor).length, 2);
let execution = current.slice(current.indexOf(startAnchor));
const pendingGuard = '    if (previousSession) requireOriginalSessionRecord(previousSession);\n';
assert.equal(execution.split(pendingGuard).length, 2);
execution = execution.replace(pendingGuard, '');
assert.equal(/codexStoredHistory|storedHistories|history-db|requireOriginalSessionRecord/.test(execution), false);
integrated = integrated.slice(0, integrated.indexOf(startAnchor)) + execution;
const oldImport = "import { runCodexAppServerTurn, CodexAppServerCancelledError } from './codexAppServer.js';";
const currentImport = current.split('\n').find(line => line.startsWith('import { runCodexAppServerTurn,'));
assert.ok(currentImport?.includes('CodexAppServerDetachedError'));
assert.equal(integrated.split(oldImport).length, 2);
integrated = integrated.replace(oldImport, currentImport
  + "\nimport { nativeClientMessageId, normalizeNativeSubmission } from './codexSharedSubmission.mjs';"
  + "\nimport { registerCodexDeploymentDrainParticipant } from './codexDeploymentDrain.mjs';");
const runMap = 'const activeCodexRuns = new Map<string, ActiveCodexRun>();';
assert.equal(integrated.split(runMap).length, 2);
integrated = integrated.replace(runMap, runMap
  + "\nregisterCodexDeploymentDrainParticipant('native-codex', () => ({ ready: true, active: activeCodexRuns.size }));");
assert.equal(/codexStoredHistory|storedHistories|history-db|requireOriginalSessionRecord/.test(integrated), false);
const output = root + '/ops/deferred-deployment/integrated-codexService.ts';
await writeFile(output, integrated, { mode: 0o600 });
console.log(JSON.stringify({ sourceOnly: true, installedEffects: false, output,
  sha256: createHash('sha256').update(integrated).digest('hex'),
  reviewedChangedContracts: ['accepted native question execution', 'accepted Ubuntu history scanner/cache',
    'native provider admission census', 'explicit opt-in canonical shared transport', 'durable native submission custody'],
}));
