#!/usr/bin/env node
import { readFile, stat } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(await readFile(resolve(runtimeDir, 'design_tools.json'), 'utf8'));
const commonInputSchema = contract.tools[0]?.inputSchema;
const tools = contract.tools.map((tool) => ({
  ...tool,
  inputSchema: typeof tool.inputSchema?.$ref === 'string' ? commonInputSchema : tool.inputSchema,
}));

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const bridgeInfoFile = readArgument('--bridge-info-file');
if (!bridgeInfoFile) {
  process.stderr.write('Missing --bridge-info-file\n');
  process.exit(2);
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

async function loadBridge() {
  const bridgePath = resolve(bridgeInfoFile);
  const fileStat = await stat(bridgePath);
  if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) {
    throw new Error('Design bridge discovery file must be owner-only');
  }
  const payload = JSON.parse(await readFile(bridgePath, 'utf8'));
  const bridgeUrl = new URL(payload.url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(bridgeUrl.hostname)
    || bridgeUrl.protocol !== 'http:'
    || typeof payload.token !== 'string'
    || payload.token.length < 32) {
    throw new Error('Design bridge discovery data is invalid');
  }
  return { url: bridgeUrl.toString().replace(/\/$/, ''), token: payload.token };
}

async function callBridge(name, args) {
  const bridge = await loadBridge();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 350_000);
  try {
    const response = await fetch(`${bridge.url}/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ name, arguments: args || {} }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      const error = payload.error || {};
      return {
        content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
        structuredContent: error,
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(payload.result, null, 2) }],
      structuredContent: payload.result,
      isError: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (!message.method) continue;
  const id = message.id;
  try {
    if (message.method === 'initialize') {
      sendResult(id, {
        protocolVersion: message.params?.protocolVersion || '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'code-ai-gemini-design-partner', version: '1.0.0' },
        instructions: 'Gemini supplies design judgment only. Codex owns all code changes and must preserve behavior.',
      });
    } else if (message.method === 'ping') {
      sendResult(id, {});
    } else if (message.method === 'tools/list') {
      sendResult(id, { tools });
    } else if (message.method === 'tools/call') {
      const name = typeof message.params?.name === 'string' ? message.params.name : '';
      sendResult(id, await callBridge(name, message.params?.arguments || {}));
    } else if (id !== undefined) {
      sendError(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    if (id !== undefined) {
      sendResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ error_code: 'DESIGN_MCP_FAILURE', message: String(error?.message || error), is_retryable: true }, null, 2) }],
        structuredContent: { error_code: 'DESIGN_MCP_FAILURE', message: String(error?.message || error), is_retryable: true },
        isError: true,
      });
    }
  }
}
