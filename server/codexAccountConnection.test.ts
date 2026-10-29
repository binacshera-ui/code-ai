import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { readCodexStoredConnection, rememberCodexApiCredential, clearCodexApiCredentialSelection } from './codexAccountConnection.js';
import { loadCodexAccountUsage } from './codexAccountUsage.js';
import { syncCodexAccountFiles } from './codexCredentialInheritance.js';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-api-connection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = { id: 'synthetic-api', codexHome: root };
  return { root, profile, auth: (value: unknown) => fs.writeFile(path.join(root, 'auth.json'), JSON.stringify(value), { mode: 0o600 }) };
}

test('API connection is authenticated without ChatGPT usage tokens, and unknown keys have no stale label', async t => {
  const f = await fixture(t);
  await f.auth({ OPENAI_API_KEY: 'sk-synthetic-api-account-a' });
  await rememberCodexApiCredential(f.profile, { id: 'credential-a', label: 'Organization A' }, 'sk-synthetic-api-account-a');
  assert.deepEqual(await readCodexStoredConnection(f.profile), {
    authenticated: true, type: 'apiKey', configured: true, credentialId: 'credential-a', credentialLabel: 'Organization A',
  });
  await f.auth({ OPENAI_API_KEY: 'sk-synthetic-api-account-b' });
  const next = await readCodexStoredConnection(f.profile);
  assert.equal(next.type, 'apiKey'); assert.equal(next.credentialLabel, null);
  assert.equal((await fs.stat(path.join(f.root, 'code-ai-api-connection.json'))).mode & 0o777, 0o600);
});

test('API mode never calls ChatGPT usage endpoints or claims ChatGPT credit', async t => {
  const f = await fixture(t);
  await f.auth({ OPENAI_API_KEY: 'sk-synthetic-api-account-a' });
  const usage = await loadCodexAccountUsage(f.profile, { forceRefresh: true,
    fetchImpl: async () => { assert.fail('API-key mode must not call ChatGPT quota endpoints'); } });
  assert.equal(usage.account.authenticated, true); assert.equal(usage.account.type, 'apiKey');
  assert.equal(usage.source, 'openai-api-key'); assert.equal(usage.billingCredits, null);
  assert.equal(usage.resetCredits, null); assert.deepEqual(usage.quotaGroups, []);
  assert.equal(usage.error, null);
});

test('logout clears only API selection metadata and preserves stored conversations', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'sessions'));
  await fs.writeFile(path.join(f.root, 'sessions', 'preserved.jsonl'), 'synthetic conversation\n');
  await rememberCodexApiCredential(f.profile, { id: 'credential-a', label: 'Organization A' }, 'sk-synthetic-api-account-a');
  await clearCodexApiCredentialSelection(f.profile);
  assert.equal(await fs.readFile(path.join(f.root, 'sessions', 'preserved.jsonl'), 'utf8'), 'synthetic conversation\n');
  assert.equal(await fs.stat(path.join(f.root, 'code-ai-api-connection.json')).then(() => true, () => false), false);
});

test('derived auth follows source login and removes stale credentials after source logout', async t => {
  const f = await fixture(t), derived = path.join(f.root, 'derived');
  await f.auth({ OPENAI_API_KEY: 'sk-synthetic-api-account-a' });
  await rememberCodexApiCredential(f.profile, { id: 'credential-a', label: 'Organization A' }, 'sk-synthetic-api-account-a');
  await syncCodexAccountFiles(f.root, derived);
  assert.equal((await readCodexStoredConnection({ id: 'derived', codexHome: derived })).credentialLabel, 'Organization A');
  await fs.rm(path.join(f.root, 'auth.json')); await clearCodexApiCredentialSelection(f.profile);
  await syncCodexAccountFiles(f.root, derived);
  assert.equal((await readCodexStoredConnection({ id: 'derived', codexHome: derived })).authenticated, false);
  assert.equal(await fs.stat(path.join(derived, 'code-ai-api-connection.json')).then(() => true, () => false), false);
});
