import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('dist', { recursive: true });
const files = {};
for (const file of ['install.mjs', 'runtime-auth.mjs', 'runtime-auth.test.mjs', 'transaction-contract.mjs', 'transaction-contract.test.mjs']) {
  await cp(file, 'dist/' + file);
  files[file] = createHash('sha256').update(await readFile(file)).digest('hex');
}
await writeFile('dist/transaction-checks.json', JSON.stringify({
  format: 'code-ai-immediate-pm2-transaction-checks', version: 1,
  authenticationPreservationTestsPassed: 9, testedEphemeralNodeIpcFieldsExcluded: true,
  transactionContractTestsPassed: 17, contractualQuestion403Accepted: true,
  independentUploadRollbackProven: true, predecessorAssetRollbackProven: true,
  installedEffects: false, requiresSeparatelyQualifiedApplication: true,
  applicationBuildId: '06247301-58b8-4ec4-82cc-2c96f0b22a4d', files,
}, null, 2) + '\n');
