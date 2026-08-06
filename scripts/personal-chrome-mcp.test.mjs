import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('stdio MCP lists tools and forwards authenticated calls', async (t) => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { echoed: received.at(-1).body.toolName } }));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const child = spawn(process.execPath, [path.join(appRoot, 'server/personal-chrome/personal_chrome_mcp_server.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      CODE_AI_PERSONAL_CHROME_CONTROL_URL: `http://127.0.0.1:${port}`,
      CODE_AI_PERSONAL_CHROME_BINDING_TOKEN: 'mcp-test-token',
      CODE_AI_PERSONAL_CHROME_DEVICE_ID: 'mcp-test-device',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));

  const responses = [];
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });
  const request = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitForId = async (id) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = responses.findIndex((entry) => entry.id === id);
      if (index >= 0) return responses.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for MCP response ${id}`);
  };

  request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal((await waitForId(1)).result.serverInfo.name, 'code-ai-personal-chrome');
  request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = (await waitForId(2)).result.tools;
  assert.equal(tools.length, 19);
  assert.ok(tools.some((tool) => tool.name === 'browser_key'));
  request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_status', arguments: {} } });
  const call = await waitForId(3);
  assert.equal(call.result.isError, false);
  assert.equal(received[0].authorization, 'Bearer mcp-test-token');
  assert.equal(received[0].body.toolName, 'browser_status');
});
