#!/usr/bin/env node
// Provision a separate Codex home and a loopback-only Gemini model gateway.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installationRecord, resolveRuntime } from './runtime-paths.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const runtimeRoot = path.resolve(option('--runtime-root', await resolveRuntime()));
const sourceHome = path.resolve(option('--source-home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
const keyFile = path.resolve(option('--key-file', path.join(os.homedir(), '.gemini/.env')));
const codexBin = await realpath(option('--codex-bin', '/usr/local/bin/codex'));
const home = path.join(runtimeRoot, 'codex-home');
const model = option('--model', 'gemini-4-argon');
const port = Number(option('--port', '4187'));
if (home === sourceHome || runtimeRoot === sourceHome || home.startsWith(sourceHome + path.sep)
    || sourceHome.startsWith(runtimeRoot + path.sep) || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('A separate runtime directory and unprivileged port are required');
}
if (!/^gemini-[a-z0-9.-]+$/.test(model)) throw new Error('Invalid Gemini model name');
if (!parseEnv(await readFile(keyFile, 'utf8')).GEMINI_API_KEY) throw new Error('The CLI environment file has no GEMINI_API_KEY');
const protectedFiles = await Promise.all(['config.toml', 'auth.json'].map(async name => {
  const file = path.join(sourceHome, name);
  try { return { file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { file, sha256: null }; }
}));
for (const dir of [runtimeRoot, home, path.join(runtimeRoot, 'evidence'), path.join(runtimeRoot, 'workspace')]) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
const tokenFile = path.join(runtimeRoot, 'gateway-key');
try { await writeFile(tokenFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
await chmod(tokenFile, 0o600);

// Reuse the installed Codex instructions; describe Gemini's actual capabilities.
const cached = JSON.parse(await readFile(path.join(sourceHome, 'models_cache.json'), 'utf8'));
const template = cached.models.find(row => row.slug === 'gpt-6.1-sol') || cached.models[0];
if (!template) throw new Error('No installed Codex model instructions were found');
const catalogModel = {
  ...template,
  slug: model, display_name: `${model} · Codex harness`,
  description: 'Gemini API through an isolated local Responses gateway',
  priority: 0, visibility: 'list', supported_in_api: true,
  default_reasoning_level: 'high',
  supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort, description: effort })),
  base_instructions: template.base_instructions || '',
  supports_reasoning_summaries: false, default_reasoning_summary: 'none',
  support_verbosity: false, default_verbosity: null,
  shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', tool_mode: 'direct',
  web_search_tool_type: 'text', supports_search_tool: false,
  supports_parallel_tool_calls: true, supports_image_detail_original: false,
  context_window: 1048576, max_context_window: 1048576, effective_context_window_percent: 90,
  auto_compact_token_limit: 850000, comp_hash: null,
  use_responses_lite: false, experimental_supported_tools: [],
  additional_speed_tiers: [], service_tiers: [], available_access_programs: { cyber: [] },
  availability_nux: null, upgrade: null,
};
await writeFile(path.join(home, 'models.json'), JSON.stringify({ models: [catalogModel] }, null, 2) + '\n', { mode: 0o600 });
const toml = JSON.stringify;
await writeFile(path.join(home, 'config.toml'), [
  `model = ${toml(model)}`,
  'model_provider = "gemini_gateway"',
  'model_reasoning_effort = "high"',
  'model_reasoning_summary = "none"',
  'model_context_window = 1048576',
  'model_auto_compact_token_limit = 850000',
  `model_catalog_json = ${toml(path.join(home, 'models.json'))}`,
  'approval_policy = "on-request"',
  'sandbox_mode = "workspace-write"',
  'web_search = "disabled"',
  '[analytics]', 'enabled = false',
  '[features]', 'code_mode = false', 'code_mode_host = false',
  '[model_providers.gemini_gateway]',
  'name = "Gemini API · isolated Codex harness"',
  `base_url = "http://127.0.0.1:${port}/v1"`,
  'wire_api = "responses"', 'env_key = "CODEX_GEMINI_GATEWAY_KEY"',
  'requires_openai_auth = false', 'supports_websockets = false',
  'request_max_retries = 2', 'stream_max_retries = 2', 'stream_idle_timeout_ms = 300000',
  '[shell_environment_policy]',
  'exclude = ["CODEX_GEMINI_GATEWAY_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]',
].join('\n') + '\n', { mode: 0o600 });
const skills = path.join(sourceHome, 'skills');
try {
  if ((await stat(skills)).isDirectory()) await symlink(skills, path.join(home, 'skills'));
} catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }

await writeFile(path.join(runtimeRoot, 'gateway.yaml'), [
  'model_list:', `  - model_name: ${model}`, '    litellm_params:',
  `      model: gemini/${model}`, '      api_key: os.environ/GEMINI_API_KEY',
  '      timeout: 300', '      num_retries: 1',
  '      additional_drop_params: [prompt_cache_key]',
  'litellm_settings:', '  drop_params: false', '  set_verbose: false',
  '  turn_off_message_logging: true', '  cache: false',
  '  callbacks: [usage_callback.meter]',
  'general_settings:', '  master_key: os.environ/CODEX_GEMINI_GATEWAY_KEY',
].join('\n') + '\n', { mode: 0o600 });
const settings = {
  runtimeRoot, sourceHome, home, keyFile, codexBin, model, port,
  launcher: path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs'),
  protectedFiles, createdAt: new Date().toISOString(),
};
await writeFile(path.join(runtimeRoot, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
let sourceHomeUnchanged = true;
for (const record of protectedFiles) {
  let digest = null;
  try { digest = createHash('sha256').update(await readFile(record.file)).digest('hex'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (digest !== record.sha256) sourceHomeUnchanged = false;
}
if (!sourceHomeUnchanged) throw new Error('The original Codex configuration changed during setup');
await mkdir(path.dirname(installationRecord), { recursive: true, mode: 0o700 });
await writeFile(installationRecord, JSON.stringify({ runtimeRoot }) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ installed: true, home, model, endpoint: `http://127.0.0.1:${port}/v1`, keySource: keyFile, sourceHomeUnchanged }, null, 2));
