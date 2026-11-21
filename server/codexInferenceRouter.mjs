/** Model transport only. Native Codex owns history, compaction and tool execution. */
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, createHash } from 'node:crypto';
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
  // Opaque OpenAI reasoning cannot be interpreted by Google. Conversation
  // messages and exact tool call/result pairs stay in the native transcript.
  if (Array.isArray(value.input)) value.input = value.input.filter(item => item.type !== 'reasoning');
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

export function createInferenceRouter(settings) {
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
      if (!/^\/v1\/(responses(?:\/compact)?|models)$/.test(url.pathname)) {
        fail(404, 'Unknown inference route'); return;
      }
      if (!await authorized(req.headers.authorization)) { fail(401, 'Code AI account authentication required'); return; }
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY) { fail(413, 'Model request is too large'); return; }
        chunks.push(chunk);
      }
      let bytes = Buffer.concat(chunks);
      const body = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
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
        if (JSON.stringify(converted) !== JSON.stringify(body)) bytes = Buffer.from(JSON.stringify(converted));
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
      upstream.on('error', () => fail(502, 'Model provider transport unavailable'));
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
  createInferenceRouter(settings).listen(settings.port, '127.0.0.1', () => console.log('Code AI inference router ready'));
}
