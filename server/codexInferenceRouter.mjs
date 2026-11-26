/** Model transport only. Native Codex owns history, compaction and tool execution. */
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { isGeminiCodexModel } from '../shared/codexGeminiModels.mjs';
import { getCodexApiModel, isCodexApiModel, isDeepseekCodexModel } from '../shared/codexApiModels.mjs';
import { parseEnv } from 'node:util';
import { subscriptionTransportBlocked } from './subscriptionQuotaFence.mjs';
import path from 'node:path';
import { ProviderStateStore, providerStateScope, filterProviderState, providerStateObserver } from './codexProviderState.mjs';

const MAX_BODY = 64 * 1024 * 1024;
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization']);

export function numericProviderUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const numeric = object => Object.fromEntries(Object.entries(object)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) || value && typeof value === 'object' && !Array.isArray(value))
    .map(([key, value]) => [key, typeof value === 'number' ? value : numeric(value)]));
  const value = numeric(usage);
  // A gateway's placeholder zero is not an observed cache miss.
  const unknown = Array.isArray(usage.unreported_token_details)
    ? usage.unreported_token_details.filter(key => ['cached_tokens', 'cache_write_tokens', 'reasoning_tokens'].includes(key)) : [];
  for (const key of unknown) {
    if (key === 'reasoning_tokens') delete value.output_tokens_details?.[key];
    else delete value.input_tokens_details?.[key];
  }
  if (unknown.length) value.unreported_token_details = unknown;
  return value;
}

export function openaiRequest(body, { stripUnsealedReasoning = true } = {}) {
  if (!Array.isArray(body?.input)) return body;
  const short = value => typeof value === 'string' && value.length > 64
    ? (value.match(/^[a-z]+_/)?.[0] || 'call_') + createHash('sha256').update(value).digest('hex').slice(0,40) : value;
  const itemId = item => {
    // Some compatible providers return fc_* IDs for custom tool calls, while
    // OpenAI requires ctc_*. Item IDs are opaque, not the tool/result call_id.
    const prefix = item.type === 'custom_tool_call' ? 'ctc_' : item.type === 'function_call' ? 'fc_' : null;
    return prefix && typeof item.id === 'string' && !item.id.startsWith(prefix)
      ? prefix + createHash('sha256').update(item.id).digest('hex').slice(0, 40) : short(item.id);
  };
  // Stateless non-OpenAI providers may expose a summary-only reasoning item.
  // OpenAI treats its ID as a stored reference and returns 404. The transport
  // separately verifies ownership of sealed reasoning before this conversion.
  return { ...body, input: body.input.filter(item => !stripUnsealedReasoning || item.type !== 'reasoning' || item.encrypted_content).map(item => ({ ...item,
    ...(item.id ? { id: itemId(item) } : {}),
    ...(item.call_id ? { call_id: short(item.call_id) } : {}),
  })) };
}

function withHistoricalTools(body) {
  const value = { ...body };
  // Native OpenAI threads also replay tool declarations as additional_tools
  // input items. Hoist once, keeping current definitions authoritative. Broad
  // adapter drop_params would silently discard unrelated unsupported behavior.
  const mergeTools = tools => {
    const entries = new Map();
    for (const tool of tools) {
      const key = tool.name ? `${tool.type}:${tool.name}` : JSON.stringify(tool);
      const previous = entries.get(key);
      entries.set(key, previous && tool.type === 'namespace'
        ? { ...tool, tools: mergeTools([...(previous.tools || []), ...(tool.tools || [])]) } : tool);
    }
    return [...entries.values()];
  };
  if (Array.isArray(value.input)) {
    const additions = value.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools || []);
    if (additions.length) value.tools = mergeTools([...additions, ...(value.tools || [])]);
    value.input = value.input.filter(item => item.type !== 'additional_tools');
  }
  return value;
}

export function geminiRequest(body) {
  const value = withHistoricalTools(body);
  if (Array.isArray(value.input)) value.input = value.input.filter(item => item.type !== 'reasoning');
  // Opaque OpenAI reasoning cannot be interpreted by Google. Conversation
  // messages and exact tool call/result pairs stay in the native transcript.
  delete value.prompt_cache_key;
  delete value.service_tier;
  delete value.include;
  if (value.reasoning) value.reasoning = { effort: value.reasoning.effort };
  return value;
}

export function deepseekRequest(body) {
  const model = getCodexApiModel(body?.model);
  if (!isDeepseekCodexModel(body?.model)) throw new Error('DeepSeek model is not registered');
  const value = withHistoricalTools(openaiRequest(body, { stripUnsealedReasoning: false }));
  value.model = model.upstreamModel;
  // Codex retains its complete native transcript. Both providers accept native
  // custom/namespace tools and reasoning replay; never flatten these ourselves.
  // API billing is independent of subscription speed/cache routing hints.
  delete value.service_tier;
  delete value.prompt_cache_key;
  value.store = false;
  if (value.reasoning) value.reasoning = { effort: value.reasoning.effort };
  if (model.provider === 'venice') value.venice_parameters = { include_venice_system_prompt: false };
  return value;
}

function equal(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export function createInferenceRouter(settings, { logger = event => console.log(JSON.stringify(event)) } = {}) {
  const providerState = new ProviderStateStore(settings.providerStateFile ||
    (settings.runtimeRoot ? path.join(settings.runtimeRoot, 'provider-state.sqlite') : ':memory:'));
  async function authorized(header) {
    if (!header?.startsWith('Bearer ')) return false;
    const token = header.slice(7);
    for (const filename of settings.authFiles) {
      try {
        const auth = JSON.parse(await readFile(filename, 'utf8'));
        if (equal(token, auth.OPENAI_API_KEY)) return { accountId: null };
        if (equal(token, auth.tokens?.access_token)) return { accountId: auth.tokens?.account_id || null };
      } catch { /* Another configured profile can be authenticated. */ }
    }
    return false;
  }
  const server = http.createServer(async (req, res) => {
    let imageMetadata = null;
    const fail = (status, message) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { message } }));
    };
    try {
      if (req.url === '/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ready: true, component: 'code-ai-inference' })); return;
      }
      const url = new URL(req.url, 'http://localhost');
      const imageRequest = /^\/v1\/images\/(generations|edits)$/.test(url.pathname);
      if (!imageRequest && !/^\/v1\/(responses(?:\/compact)?|models)$/.test(url.pathname)) {
        fail(404, 'Unknown inference route'); return;
      }
      const authentication = await authorized(req.headers.authorization);
      if (!authentication) { fail(401, 'Code AI account authentication required'); return; }
      if (imageRequest) {
        if (req.method !== 'POST') { fail(405, 'Image requests require POST'); return; }
        const requestId = randomUUID(), started = performance.now();
        let completed = false;
        imageMetadata = { requestId, method: req.method, route: url.pathname, provider: 'openai' };
        logger({ event: 'inference.image.started', ...imageMetadata });
        const finish = () => {
          if (completed) return;
          completed = true;
          logger({ event: 'inference.image.finished', ...imageMetadata,
            durationMs: Math.round(performance.now() - started), status: res.statusCode,
            completed: res.writableFinished });
        };
        res.once('finish', finish);
        res.once('close', finish);
      }
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY) { fail(413, 'Model request is too large'); return; }
        chunks.push(chunk);
      }
      let bytes = Buffer.concat(chunks);
      // Built-in OpenAI threads in Codex 0.171 compress Responses requests.
      // Read the model from bounded decoded JSON, but retain exact original
      // GPT bytes unless a cross-provider tool-ID conversion is necessary.
      const encoding = req.headers['content-encoding']?.trim().toLowerCase();
      let decoded = bytes;
      if (!imageRequest && bytes.length && encoding && encoding !== 'identity') {
        const decoder = { zstd: zlib.zstdDecompress, gzip: zlib.gunzip, deflate: zlib.inflate, br: zlib.brotliDecompress }[encoding];
        if (!decoder) { fail(415, 'Unsupported model request encoding'); return; }
        decoded = await promisify(decoder)(bytes, { maxOutputLength: MAX_BODY });
      }
      // Native image editing sends multipart files. Image requests belong to
      // OpenAI and pass through byte-for-byte, including boundaries/encoding;
      // only Responses JSON needs model routing and tool-history conversion.
      let body = !imageRequest && decoded.length ? JSON.parse(decoded.toString('utf8')) : null;
      const gemini = isGeminiCodexModel(body?.model);
      const deepseek = isDeepseekCodexModel(body?.model);
      const api = isCodexApiModel(body?.model);
      if (body?.model?.startsWith('gemini-') && !gemini) { fail(400, 'Gemini model is not registered'); return; }
      if (body?.model?.startsWith('deepseek-') && !deepseek) { fail(400, 'DeepSeek model is not registered'); return; }
      const apiModel = deepseek ? getCodexApiModel(body.model) : null;
      if (deepseek && !settings.providerKeys?.[apiModel.credentialEnv]) { fail(503, 'DeepSeek provider credentials are not configured'); return; }
      if (deepseek && url.pathname !== '/v1/responses') { fail(400, 'DeepSeek uses native Codex local compaction, not a hosted compact endpoint'); return; }
      const quotaStateFile = settings.quotaStopStateFile || process.env.CODE_AI_QUOTA_STOP_STATE_FILE;
      const blocked = () => subscriptionTransportBlocked(quotaStateFile, authentication.accountId, body?.model);
      if (req.method === 'POST' && await blocked()) {
        fail(423, 'Subscription quota stop is active; model work is paused.'); return;
      }
      const baseUrl = deepseek ? (settings.providerBaseUrls?.[apiModel.provider] || apiModel.apiBase)
        : gemini ? settings.geminiBaseUrl : settings.openaiBaseUrl;
      const provider = deepseek ? apiModel.provider : gemini ? 'gemini' : 'openai';
      const scope = !imageRequest && body ? providerStateScope({ provider, endpoint: baseUrl,
        accountId: api ? null : authentication.accountId,
        accountHeader: api ? null : req.headers['chatgpt-account-id'],
        credential: deepseek ? settings.providerKeys[apiModel.credentialEnv]
          : gemini ? settings.geminiGatewayKey : req.headers.authorization }) : null;
      let stateRemoved = 0;
      if (scope) {
        const filtered = filterProviderState(body, providerState, scope);
        body = filtered.body;
        stateRemoved = filtered.removed;
        if (stateRemoved) logger({ event: 'inference.state.filtered', provider, model: body.model, removed: stateRemoved });
      }
      const target = new URL(url.pathname.slice('/v1'.length) + url.search, baseUrl + '/');
      // URL paths are appended explicitly; a leading slash would discard /v1
      // or /backend-api/codex from the configured provider endpoint.
      target.pathname = new URL(baseUrl).pathname.replace(/\/$/, '') + url.pathname.slice('/v1'.length);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name)));
      headers['accept-encoding'] = 'identity';
      if (api) {
        bytes = Buffer.from(JSON.stringify(deepseek ? deepseekRequest(body) : geminiRequest(body)));
        // OpenAI's account credential must never cross the Google boundary.
        for (const name of Object.keys(headers)) {
          if (!['content-type', 'accept', 'accept-encoding', 'user-agent'].includes(name)) delete headers[name];
        }
        headers.authorization = `Bearer ${deepseek ? settings.providerKeys[apiModel.credentialEnv] : settings.geminiGatewayKey}`;
      } else if (body) {
        // Gemini encodes thought signatures inside tool IDs. OpenAI has a
        // 64-character ID limit; map matching call/result IDs consistently.
        const converted = openaiRequest(body);
        if (stateRemoved || JSON.stringify(converted) !== JSON.stringify(body)) {
          bytes = Buffer.from(JSON.stringify(converted));
          delete headers['content-encoding'];
        }
      }
      if (bytes.length) headers['content-length'] = String(bytes.length);
      const upstream = (target.protocol === 'https:' ? https : http).request(target, {
        method: req.method, headers,
      }, incoming => {
        const responseHeaders = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !HOP_HEADERS.has(name)));
        if (scope && incoming.statusCode >= 200 && incoming.statusCode < 300) {
          const observer = providerStateObserver(incoming.headers['content-type'], item =>
            providerState.record(item, { scope, provider, model: body.model }));
          let failed = false;
          const observe = action => {
            if (failed) return;
            try { action(); }
            catch { failed = true; logger({ event: 'inference.state.observe_failed', provider }); }
          };
          incoming.on('data', chunk => observe(() => observer.push(chunk)));
          incoming.once('end', () => observe(() => observer.end()));
        }
        if (deepseek) {
          let pendingLine = '', reported = false, oversized = false;
          const report = response => {
            if (reported) return;
            const usage = numericProviderUsage(response?.usage);
            if (!usage) return;
            reported = true;
            logger({ event: 'inference.api.usage', provider: apiModel.provider, model: body.model, usage });
          };
          incoming.on('data', chunk => {
            if (reported || oversized) return;
            pendingLine += chunk.toString('utf8');
            if (pendingLine.length > MAX_BODY) { oversized = true; pendingLine = ''; return; }
            const lines = pendingLine.split('\n'); pendingLine = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const event = JSON.parse(line.slice(6));
                if (['response.completed', 'response.incomplete'].includes(event.type)) report(event.response);
              } catch { /* Non-JSON SSE markers are not usage. */ }
            }
          });
          incoming.once('end', () => {
            if (!reported && !oversized && pendingLine.startsWith('{')) {
              try { report(JSON.parse(pendingLine)); } catch { /* No usage reported. */ }
            }
          });
        }
        res.writeHead(incoming.statusCode || 502, responseHeaders);
        incoming.pipe(res);
        incoming.on('error', () => res.destroy());
      });
      upstream.setTimeout(360000, () => upstream.destroy());
      // Fencing future samples is not enough: stop already-streaming model and
      // image requests when the same durable account latch trips.
      if (quotaStateFile && authentication.accountId && !api && req.method === 'POST') {
        let checking = false;
        const poll = setInterval(async () => {
          if (checking) return;
          checking = true;
          try { if (await blocked()) { upstream.destroy(); res.destroy(); } }
          finally { checking = false; }
        }, 500);
        poll.unref();
        res.once('close', () => clearInterval(poll));
        res.once('finish', () => clearInterval(poll));
      }
      upstream.on('error', error => {
        if (imageMetadata) logger({ event: 'inference.image.transport_failed', ...imageMetadata,
          code: error.code || error.name, stage: 'provider' });
        fail(502, 'Model provider transport unavailable');
      });
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.end(bytes);
    } catch (error) {
      if (error.code === 'provider_state_checkpoint_mismatch') fail(409, error.message);
      else fail(400, 'Invalid model request');
    }
  });
  server.requestTimeout = 0;
  server.once('close', () => providerState.close());
  return server;
}

/** A successor may wait for the old listener to close while old streams drain. */
export async function listenInferenceServer(server, port, { waitMs = 0, retryMs = 100 } = {}) {
  const deadline = performance.now() + waitMs;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const ready = () => { server.off('error', failed); resolve(); };
        const failed = error => { server.off('listening', ready); reject(error); };
        server.once('listening', ready); server.once('error', failed);
        server.listen(port, '127.0.0.1');
      });
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || performance.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const settings = JSON.parse(await readFile(process.argv[2], 'utf8'));
  settings.geminiGatewayKey = (await readFile(settings.gatewayKeyFile, 'utf8')).trim();
  if (settings.providerKeyFile) settings.providerKeys = parseEnv(await readFile(settings.providerKeyFile, 'utf8'));
  const server = createInferenceRouter(settings);
  await listenInferenceServer(server, settings.port, { waitMs: Number(process.env.CODE_AI_INFERENCE_BIND_WAIT_MS || 0) });
  console.log('Code AI inference router ready');
  // Stop accepting requests while existing model/image streams complete.
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
}
