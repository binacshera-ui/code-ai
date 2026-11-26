import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
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
  assert.equal(catalog.models.filter(m => m.slug.startsWith('deepseek-')).length, 0);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-deepseek-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); await mkdir(home);
  const original = 'model = "deepseek-v4.1-flash-experiential"\nmodel_reasoning_effort = "low"\nservice_tier = "ultrafast"\n[mcp_servers.fixture]\ncommand = "fixture-command"\n';
  await writeFile(path.join(home, 'config.toml'), original);
  await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', additional_speed_tiers: ['ultrafast'], input_modalities: ['text', 'image'] },
    { slug: 'gemini-4-neon' }, { slug: 'deepseek-v4.1-flash-venice' },
  ] }));
  await writeFile(path.join(home, 'auth.json'), '{"fixture":"untouched"}');
  const keyFile = path.join(root, 'gemini.env');
  await writeFile(keyFile, 'GEMINI_API_KEY=fixture-gemini-private\n', { mode: 0o600 });
  const providerKeyFile = path.join(root, 'providers.env');
  await writeFile(providerKeyFile, 'VENICE_API_KEY=fixture-venice-private\nEXPLABS_API_KEY=fixture-experiential-private\n', { mode: 0o600 });
  const runtime = path.join(root, 'runtime');
  const args = [new URL('./install.mjs', import.meta.url).pathname, '--runtime-root', runtime,
    '--codex-home', home, '--key-file', keyFile];
  return { home, original, providerKeyFile, runtime, args };
}

test('private direct-provider keys enable exactly both DeepSeek choices without changing native settings or Gemini adapter', async t => {
  const { home, original, providerKeyFile, runtime, args } = await fixture(t);
  const install = await promisify(execFile)(process.execPath, [...args, '--provider-key-file', providerKeyFile, '--port', '4196',
    '--openai-base-url', 'https://fixture.example/backend-api/codex', '--storage-root', path.join(runtime, 'private-storage')]);
  const once = await readFile(path.join(home, 'config.toml'), 'utf8');
  assert.ok(once.includes(original.trim()));
  assert.equal(await readFile(path.join(home, 'auth.json'), 'utf8'), '{"fixture":"untouched"}');
  const catalogText = await readFile(path.join(home, 'code-ai-models.json'), 'utf8');
  const catalog = JSON.parse(catalogText).models;
  assert.deepEqual(catalog.filter(m => m.slug.startsWith('deepseek-')).map(m => m.slug).sort(), [
    'deepseek-v4.1-flash-experiential', 'deepseek-v4.1-flash-venice',
  ]);
  assert.equal(catalog.filter(m => m.slug.startsWith('gemini-')).length, 4);
  assert.deepEqual(catalog.find(m => m.slug === 'gpt-6.1-sol').additional_speed_tiers, ['ultrafast']);
  assert.equal(new Set(catalog.map(m => m.slug)).size, catalog.length);
  const settingsText = await readFile(path.join(runtime, 'settings.json'), 'utf8');
  const settings = JSON.parse(settingsText);
  assert.equal(settings.providerKeyFile, providerKeyFile);
  const yaml = await readFile(path.join(runtime, 'adapter.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /deepseek|VENICE_API_KEY|EXPLABS_API_KEY/);
  assert.doesNotMatch(once + catalogText + settingsText + yaml + install.stdout, /fixture-(gemini|venice|experiential)-private/);
  assert.equal((await stat(path.join(runtime, 'settings.json'))).mode & 0o777, 0o600);
  // A normal rerun keeps the already configured private credentials and route.
  await promisify(execFile)(process.execPath, args);
  assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), once);
  assert.equal(await readFile(path.join(home, 'code-ai-models.json'), 'utf8'), catalogText);
  const rerun = JSON.parse(await readFile(path.join(runtime, 'settings.json'), 'utf8'));
  assert.equal(rerun.providerKeyFile, providerKeyFile);
  assert.equal(rerun.port, 4196);
  assert.equal(rerun.openaiBaseUrl, settings.openaiBaseUrl);
  assert.equal(rerun.quotaStopStateFile, settings.quotaStopStateFile);
  assert.equal(await readFile(path.join(runtime, 'adapter.yaml'), 'utf8'), yaml);
});

for (const invalid of ['missing-key', 'public-file', 'missing-file']) {
  test(`invalid direct-provider key source (${invalid}) fails before profile or runtime mutation`, async t => {
    const { home, original, providerKeyFile, runtime, args } = await fixture(t);
    if (invalid === 'missing-key') await writeFile(providerKeyFile, 'VENICE_API_KEY=fixture-only\n');
    if (invalid === 'public-file') await chmod(providerKeyFile, 0o644);
    const selected = invalid === 'missing-file' ? path.join(runtime, 'nonexistent.env') : providerKeyFile;
    await assert.rejects(promisify(execFile)(process.execPath, [...args, '--provider-key-file', selected]),
      error => /Provider API key/.test(error.stderr) && !/fixture-only|fixture-venice-private|fixture-experiential-private/.test(error.stderr));
    assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), original);
    await assert.rejects(stat(runtime), { code: 'ENOENT' });
  });
}
