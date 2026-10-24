import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mechanical packaging only; no build, provider invocation or installed effect.
const root = path.dirname(fileURLToPath(import.meta.url));
await cp(path.join(root, '../codex-interactive-release/fake-codex.mjs'), path.join(root, 'fake-codex.mjs'));
const apiOriginal = await readFile(path.join(root, '../codex-interactive-release/api-smoke.mjs'), 'utf8');
const singletonAnchor = "CODEX_QUEUE_DISABLE_EXECUTION: '0', CODE_AI_PASSIVE_HTTP_NODE: '0',";
assert.equal(apiOriginal.split(singletonAnchor).length, 2, 'Synthetic ingress metadata anchor changed');
await writeFile(path.join(root, 'api-smoke.mjs'), apiOriginal.replace(singletonAnchor,
  singletonAnchor + "\n    CODE_AI_HTTP_SINGLE_INGRESS: '1',"));
const original = await readFile(path.join(root, 'drain-smoke.mjs'), 'utf8');
const anchor = "from '../codex-interactive-release/api-smoke.mjs'";
assert.equal(original.split(anchor).length, 2, 'Drain smoke packaging anchor changed');
await writeFile(path.join(root, 'drain-audit-smoke.mjs'), original.replace(anchor, "from './api-smoke.mjs'"));
const coordinatorOriginal = await readFile(path.join(root, 'coordinator.test.mjs'), 'utf8');
const coordinatorAnchor = "from '../../server/codexDeploymentDrain.mjs'";
assert.equal(coordinatorOriginal.split(coordinatorAnchor).length, 2, 'Coordinator packaging anchor changed');
await writeFile(path.join(root, 'coordinator-audit.test.mjs'), coordinatorOriginal.replace(coordinatorAnchor,
  "from './payload/server/codexDeploymentDrain.mjs'"));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const overlayPaths = [
  'server/agentService.ts', 'server/codexTerminal.ts', 'server/index.ts', 'server/codexQueue.ts',
  'server/codexQueue.drafts.test.ts', 'server/codexAppServer.ts', 'server/codexAppServer.test.ts',
  'server/codexUserInput.ts', 'server/codexUserInput.test.ts',
  'server/codexSharedSubmission.mjs', 'server/codexSharedSubmission.test.mjs',
  'server/codexDeploymentDrain.mjs', 'server/codexDeploymentDrain.test.mjs',
  'scripts/codex-shared-stdio.mjs', 'scripts/codex-shared-stdio.test.mjs',
  'client/src/components/codex/deploymentRetry.ts', 'client/src/components/codex/deploymentRetry.test.ts',
];
const qualificationPaths = ['package.json', 'pnpm-lock.yaml', 'test.mjs', 'build.mjs',
  'api-smoke.mjs', 'fake-codex.mjs', 'drain-audit-smoke.mjs',
  'coordinator.mjs', 'coordinator-audit.test.mjs', 'controller-client.mjs', 'systemd/render-units.mjs'];
const projectRoot = path.resolve(root, '../..');
const hashPaths = async (directory, files) => Promise.all(files.map(async filename => ({
  path: filename, sha256: sha(await readFile(path.join(directory, filename))),
})));
const integrationPath = path.join(root, 'integrated-codexService.ts');
const freeze = {
  format: 'code-ai-deferred-source-freeze', version: 1, streamsComplete: true,
  purpose: 'nondeployable-offline-contract-audit', productionReady: false,
  overlays: await hashPaths(projectRoot, overlayPaths),
  qualificationFiles: await hashPaths(root, qualificationPaths),
  serviceIntegration: {
    path: integrationPath, sha256: sha(await readFile(integrationPath)),
    reviewedChangedContracts: ['accepted Ubuntu history', 'native questions and previews',
      'tracked drain admission', 'explicitly disabled shared native custody and recovery'],
  },
};
await writeFile(path.join(root, 'source-freeze.json'), JSON.stringify(freeze, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ prepared: true, productionReady: false,
  deploymentArtifact: false, overlays: overlayPaths.length, qualificationFiles: qualificationPaths.length }));
