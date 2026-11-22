import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

test('provisioning leaves legacy OpenAI routing untouched and is idempotent', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-inference-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); await mkdir(home);
  const original = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n[mcp_servers.fixture]\ncommand = "fixture-command"\n';
  await writeFile(path.join(home, 'config.toml'), original);
  await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol' }] }));
  await writeFile(path.join(home, 'auth.json'), '{"fixture":"untouched"}');
  const keyFile = path.join(root, 'fixture.env'); await writeFile(keyFile, 'GEMINI_API_KEY=fixture-not-a-real-key\n');
  const args = [new URL('./install.mjs', import.meta.url).pathname, '--runtime-root', path.join(root, 'runtime'),
    '--codex-home', home, '--key-file', keyFile, '--port', '4194'];
  await promisify(execFile)(process.execPath, args);
  const once = await readFile(path.join(home, 'config.toml'), 'utf8');
  await promisify(execFile)(process.execPath, args);
  assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), once);
  assert.ok(!once.includes('openai_base_url'));
  assert.match(once, /^model_provider = "code_ai"$/m);
  assert.ok(!once.includes('[model_providers.openai]'));
  assert.ok(once.includes('model = "gpt-6.1-sol"') && once.includes('command = "fixture-command"'));
  assert.equal(await readFile(path.join(home, 'auth.json'), 'utf8'), '{"fixture":"untouched"}');
  const catalog = JSON.parse(await readFile(path.join(home, 'code-ai-models.json')));
  assert.equal(catalog.models.filter(m => m.slug.startsWith('gemini-4-')).length, 4);
});
