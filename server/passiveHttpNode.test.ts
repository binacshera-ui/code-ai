import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('passive HTTP mode cannot start singleton workers or browser sockets', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(source, /CODE_AI_PASSIVE_HTTP_NODE === '1'/);
  assert.match(source, /if \(!PASSIVE_HTTP_NODE\) \{\s*attachPersonalChromeBridge\(server\)/);
  const listener = source.slice(source.indexOf("server.once('listening'"));
  assert.ok(listener.indexOf('if (PASSIVE_HTTP_NODE)') < listener.indexOf('repairAllProviderHomesOwnership'));
  assert.ok(listener.indexOf('if (PASSIVE_HTTP_NODE)') < listener.indexOf('startCodexQueueWorker'));
  assert.ok(listener.indexOf('if (PASSIVE_HTTP_NODE)') < listener.indexOf('startCodexFinalNotificationWorker'));
  assert.ok(listener.indexOf('if (PASSIVE_HTTP_NODE)') < listener.indexOf('startPersonalPortForwardBroker'));
});
