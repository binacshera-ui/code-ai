/** Model transport only. Native Codex owns history, compaction and tool execution. */
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { isGeminiCodexModel } from '../shared/codexGeminiModels.mjs';

const MAX_BODY = 64 * 1024 * 1024;
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization']);

export function openaiRequest(body) {
  if (!Array.isArray(body?.input)) return body;
  const short = value => typeof value === 'string' && value.length > 64
    ? (value.match(/^[a-z]+_/)?.[0] || 'call_') + createHash('sha256').update(value).digest('hex').slice(0,40) : value;
  return { ...body, input: body.input.map(item => ({ ...item,
    ...(item.id ? { id: short(item.id) } : {}),
    ...(item.call_id ? { call_id: short(item.call_id) } : {}),
  })) };
}

export function geminiRequest(body) {
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
    value.input = value.input.filter(item => !['reasoning', 'additional_tools'].includes(item.type));
  }
  // Opaque OpenAI reasoning cannot be interpreted by Google. Conversation
  // messages and exact tool call/result pairs stay in the native transcript.
  delete value.prompt_cache_key;
  delete value.service_tier;
  delete value.include;
  if (value.reasoning) value.reasoning = { effort: value.reasoning.effort };
  return value;
}

function equal(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export function createInferenceRouter(settings, { logger = event => console.log(JSON.stringify(event)) } = {}) {
  async function authorized(header) {
    if (!header?.startsWith('Bearer ')) return false;
    const token = header.slice(7);
    for (const filename of settings.authFiles) {
      try {
        const auth = JSON.parse(await readFile(filename, 'utf8'));
        if (equal(token, auth.tokens?.access_token) || equal(token, auth.OPENAI_API_KEY)) return true;
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
      if (!await authorized(req.headers.authorization)) { fail(401, 'Code AI account authentication required'); return; }
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
      const body = !imageRequest && decoded.length ? JSON.parse(decoded.toString('utf8')) : null;
      const gemini = isGeminiCodexModel(body?.model);
      if (body?.model?.startsWith('gemini-') && !gemini) { fail(400, 'Gemini model is not registered'); return; }
      const target = new URL(url.pathname.slice('/v1'.length) + url.search, (gemini ? settings.geminiBaseUrl : settings.openaiBaseUrl) + '/');
      // URL paths are appended explicitly; a leading slash would discard /v1
      // or /backend-api/codex from the configured provider endpoint.
      target.pathname = new URL(gemini ? settings.geminiBaseUrl : settings.openaiBaseUrl).pathname.replace(/\/$/, '') + url.pathname.slice('/v1'.length);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name)));
      headers['accept-encoding'] = 'identity';
      if (gemini) {
        bytes = Buffer.from(JSON.stringify(geminiRequest(body)));
        // OpenAI's account credential must never cross the Google boundary.
        for (const name of Object.keys(headers)) {
          if (!['content-type', 'accept', 'accept-encoding', 'user-agent'].includes(name)) delete headers[name];
        }
        headers.authorization = `Bearer ${settings.geminiGatewayKey}`;
      } else if (body) {
        // Gemini encodes thought signatures inside tool IDs. OpenAI has a
        // 64-character ID limit; map matching call/result IDs consistently.
        const converted = openaiRequest(body);
        if (JSON.stringify(converted) !== JSON.stringify(body)) {
          bytes = Buffer.from(JSON.stringify(converted));
          delete headers['content-encoding'];
        }
      }
      if (bytes.length) headers['content-length'] = String(bytes.length);
      const upstream = (target.protocol === 'https:' ? https : http).request(target, {
        method: req.method, headers,
      }, incoming => {
        const responseHeaders = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !HOP_HEADERS.has(name)));
        res.writeHead(incoming.statusCode || 502, responseHeaders);
        incoming.pipe(res);
        incoming.on('error', () => res.destroy());
      });
      upstream.setTimeout(360000, () => upstream.destroy());
      upstream.on('error', error => {
        if (imageMetadata) logger({ event: 'inference.image.transport_failed', ...imageMetadata,
          code: error.code || error.name, stage: 'provider' });
        fail(502, 'Model provider transport unavailable');
      });
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.end(bytes);
    } catch { fail(400, 'Invalid model request'); }
  });
  server.requestTimeout = 0;
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const settings = JSON.parse(await readFile(process.argv[2], 'utf8'));
  settings.geminiGatewayKey = (await readFile(settings.gatewayKeyFile, 'utf8')).trim();
  const server = createInferenceRouter(settings);
  server.listen(settings.port, '127.0.0.1', () => console.log('Code AI inference router ready'));
  // Stop accepting requests while existing model/image streams complete.
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
}
