#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { modeServers, callSharedMode, modeFailure, modeError } from './transport.mjs';

const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const server = argument('--server'), socketPath = argument('--socket'), catalogPath = argument('--catalog');
if (!modeServers.includes(server) || !socketPath || !catalogPath || !path.isAbsolute(socketPath) || !path.isAbsolute(catalogPath)) {
  process.stderr.write('CODE_AI_SHARED_MODE_CONFIGURATION_INVALID\n'); process.exit(2);
}
let tools;
try {
  const info = await lstat(catalogPath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 2 * 1024 * 1024) throw new Error();
  tools = JSON.parse(await readFile(catalogPath, 'utf8')).tools;
  if (!Array.isArray(tools) || !tools.length || tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.inputSchema)) throw new Error();
} catch {
  process.stderr.write('CODE_AI_SHARED_MODE_CATALOG_INVALID\n'); process.exit(2);
}
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (Buffer.byteLength(line) > 8 * 1024 * 1024) { input.close(); return; }
  let message;
  try { message = JSON.parse(line); } catch { write({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const id = message?.id;
  if (message?.method === 'initialize') write({ id, result: {
    protocolVersion: message.params?.protocolVersion || '2025-11-25', capabilities: { tools: {} },
    serverInfo: { name: `code-ai-shared-${server}`, version: '1.0.0' },
  } });
  else if (message?.method === 'ping') write({ id, result: {} });
  else if (message?.method === 'tools/list') write({ id, result: { tools } });
  else if (message?.method === 'tools/call') {
    void (async () => {
      if (!tools.some(tool => tool.name === message.params?.name)) throw modeError('UNKNOWN_TOOL');
      return callSharedMode(socketPath, server, message.params);
    })().then(result => write({ id, result }), error => write({ id, result: modeFailure(error) }));
  } else if (id !== undefined) write({ id, error: { code: -32601, message: 'Method not found' } });
});
