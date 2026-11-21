#!/usr/bin/env node
/** Provision Code AI's shared model transport. No separate Codex home/session store. */
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { geminiCodexCatalog, GEMINI_CODEX_MODELS } from '../../../shared/codexGeminiModels.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const homes = args.flatMap((arg, index) => arg === '--codex-home' ? [path.resolve(args[index + 1])] : []);
if (!homes.length) throw new Error('At least one --codex-home is required');
const runtimeRoot = path.resolve(option('--runtime-root', path.join(process.cwd(), '.code-ai/local/inference')));
const keyFile = path.resolve(option('--key-file', ''));
if (!parseEnv(await readFile(keyFile, 'utf8')).GEMINI_API_KEY) throw new Error('Gemini API key is unavailable');
await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
const keyPath = path.join(runtimeRoot, 'adapter-key');
try { await writeFile(keyPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const routerPort = Number(option('--port', '4188'));
const adapterPort = Number(option('--adapter-port', '4189'));
const settings = {
  runtimeRoot, keyFile, port: routerPort, adapterPort,
  geminiBaseUrl: `http://127.0.0.1:${adapterPort}/v1`,
  openaiBaseUrl: option('--openai-base-url', 'https://chatgpt.com/backend-api/codex'),
  authFiles: homes.map(home => path.join(home, 'auth.json')), gatewayKeyFile: keyPath,
};
await writeFile(path.join(runtimeRoot, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
await writeFile(path.join(runtimeRoot, 'adapter.yaml'), [
  'model_list:', ...GEMINI_CODEX_MODELS.flatMap(model => [
    `  - model_name: ${model.slug}`, '    litellm_params:', `      model: gemini/${model.slug}`,
    '      api_key: os.environ/GEMINI_API_KEY', '      timeout: 300', '      num_retries: 1',
    '      additional_drop_params: [prompt_cache_key]',
  ]),
  'litellm_settings:', '  drop_params: false', '  set_verbose: false',
  '  turn_off_message_logging: true', '  cache: false', '  callbacks: [usage_callback.meter]',
  'general_settings:', '  master_key: os.environ/CODEX_GEMINI_GATEWAY_KEY',
].join('\n') + '\n', { mode: 0o600 });

for (const home of homes) {
  const filename = path.join(home, 'config.toml');
  const before = await readFile(filename, 'utf8');
  const cached = JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8'));
  const base = cached.models.filter(model => !model.slug.startsWith('gemini-'));
  const template = base.find(model => model.slug === 'gpt-6.1-sol') || base[0];
  if (!template) throw new Error('Native model catalog is missing');
  const catalog = path.join(home, 'code-ai-models.json');
  await writeFile(catalog, JSON.stringify({ models: [...base, ...geminiCodexCatalog(template)] }, null, 2) + '\n', { mode: 0o600 });
  const backup = path.join(runtimeRoot, `config-${path.basename(path.dirname(home))}.before.toml`);
  try { await writeFile(backup, before, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // One catalog and transport for both model families. Existing threads resume
  // with an explicit provider override while retaining their native thread ID.
  let after = before.replace(/^(model_catalog_json|model_provider)\s*=.*\r?\n/gm, '')
    .replace(/\n?# BEGIN CODE AI INFERENCE\n[\s\S]*?# END CODE AI INFERENCE\n?/g, '\n');
  if (/^\[model_providers\.openai\]/m.test(after)) throw new Error('Existing OpenAI provider override requires explicit merging');
  after = `model_provider = "code_ai"\nmodel_catalog_json = ${JSON.stringify(catalog)}\n` + after.trimEnd() + '\n\n' + [
    '# BEGIN CODE AI INFERENCE', '[model_providers.code_ai]',
    'name = "Code AI"', `base_url = "http://127.0.0.1:${routerPort}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = true', 'supports_websockets = false',
    '# END CODE AI INFERENCE', '',
  ].join('\n');
  await writeFile(filename, after, { mode: 0o600 });
}
console.log(JSON.stringify({ provisioned: true, runtimeRoot: await realpath(runtimeRoot), profiles: homes.length, models: GEMINI_CODEX_MODELS.map(model => model.slug) }));
