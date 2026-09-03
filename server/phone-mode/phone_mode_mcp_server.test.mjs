import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import readline from 'node:readline';
import test from 'node:test';

test('phone mode MCP emits screenshots as image content without duplicating base64 in text', async (context) => {
  const imageData = Buffer.from('reapre-image-test').toString('base64');
  const bridge = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request body before replying.
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      ok: true,
      correlationId: 'test-correlation',
      result: {
        id: 'test-command',
        success: true,
        data: { mimeType: 'image/jpeg', imageBase64: imageData, width: 10, height: 20 },
      },
    }));
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  context.after(() => bridge.close());
  const address = bridge.address();
  assert.ok(address && typeof address !== 'string');

  const child = spawn(process.execPath, [new URL('./phone_mode_mcp_server.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      CODE_AI_PHONE_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
      CODE_AI_PHONE_BRIDGE_TOKEN: 'test-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  context.after(() => child.kill('SIGTERM'));
  const lines = readline.createInterface({ input: child.stdout });
  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 5_000);
    lines.once('line', (line) => {
      clearTimeout(timeout);
      resolve(JSON.parse(line));
    });
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'phone_read', arguments: { tool: 'mobile_screen', command: 'screenshot', params: {} } },
  })}\n`);

  const response = await responsePromise;
  assert.equal(response.result.isError, false);
  const textBlock = response.result.content.find((item) => item.type === 'text');
  const imageBlock = response.result.content.find((item) => item.type === 'image');
  assert.match(textBlock.text, /image data omitted/);
  assert.doesNotMatch(textBlock.text, new RegExp(imageData));
  assert.deepEqual(imageBlock, { type: 'image', data: imageData, mimeType: 'image/jpeg' });
});

test('phone status sends all seven bridge probes concurrently', async (context) => {
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const commands = [];
  const bridge = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    commands.push(body.arguments.command);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeRequests -= 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      ok: true,
      correlationId: `correlation-${body.arguments.command}`,
      result: { success: true, command: body.arguments.command },
    }));
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  context.after(() => bridge.close());
  const address = bridge.address();
  assert.ok(address && typeof address !== 'string');

  const child = spawn(process.execPath, [new URL('./phone_mode_mcp_server.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      CODE_AI_PHONE_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
      CODE_AI_PHONE_BRIDGE_TOKEN: 'test-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  context.after(() => child.kill('SIGTERM'));
  const lines = readline.createInterface({ input: child.stdout });
  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 5_000);
    lines.once('line', (line) => {
      clearTimeout(timeout);
      resolve(JSON.parse(line));
    });
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'phone_status', arguments: {} },
  })}\n`);

  const response = await responsePromise;
  assert.equal(response.result.isError, false);
  assert.equal(commands.length, 7);
  assert.equal(maximumActiveRequests, 7);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.result.device.command, 'getDeviceInfo');
  assert.equal(payload.result.screen.command, 'getScreenSize');
  assert.equal(payload.correlationIds.length, 7);
});
