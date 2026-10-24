import { execFileSync } from 'node:child_process';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { smoke as interactiveSmoke } from './api-smoke.mjs';
import { smoke as drainSmoke } from './drain-audit-smoke.mjs';

// This is an offline contract audit, NOT a releasable application artifact.
// Compile and exercise the real app privately, then export evidence only.
execFileSync('npm', ['run', 'build'], { cwd: 'payload', stdio: 'inherit' });
await cp('payload/scripts/codex-shared-stdio.mjs', 'payload/dist/codex-shared-stdio.mjs');
const options = {
  appRoot: new URL('./payload/', import.meta.url).pathname,
  fakeCodex: new URL('./fake-codex.mjs', import.meta.url).pathname,
};
const interactive = await interactiveSmoke(options);
const drain = await drainSmoke(options);
await mkdir('dist/qualification', { recursive: true });
const evidence = {
  format: 'code-ai-deferred-offline-contract-audit', version: 1,
  compiledApplication: true, installedEffects: false, productionReady: false,
  deploymentArtifact: false, authenticationChanged: false, realInference: false,
  unit: JSON.parse(await readFile('unit-audit.json', 'utf8')),
  interactive, drain,
  unresolvedProductionGates: [
    'Legacy already-aborted async handlers have no proven retrospective admission census',
    'Installed legacy passive HTTP ingress has no aggregate admission fence; future source peer contract is isolated-tested only',
    'Application HTTP lifecycle remains unqualified: proxy middleware, session-store callbacks, excluded ingress and external settlement block seal unconditionally',
    'Native queued input has no atomic per-submission model/MCP configuration pin',
    'Native completion-before-custody-proof ordering and cross-process answer delivery persistence remain unqualified',
    'Windows reachability and live GUI/browser acceptance remain unverified',
  ],
};
await writeFile('dist/qualification/offline-contract-audit.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ compiledApplication: true, offlineContractAuditPassed: true,
  deploymentArtifact: false, productionReady: false, installedEffects: false }));
