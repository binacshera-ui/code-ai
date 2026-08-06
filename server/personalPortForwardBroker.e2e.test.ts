import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  closePersonalPortForward,
  openPersonalPortForward,
  shutdownPersonalPortForwardBroker,
} from './personalPortForwardBroker.js';

const execFileAsync = promisify(execFile);
const sshTarget = process.env.CODE_AI_PERSONAL_SSH_TARGET || 'personal-windows-ssh';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(address && typeof address === 'object' ? address.port : 0);
    });
  });
}

test('port broker exposes a controller-loopback service on Windows loopback and closes it', { timeout: 30_000 }, async (t) => {
  const marker = `code-ai-port-e2e-${Date.now()}`;
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/plain');
    response.end(marker);
  });
  const sourcePort = await listen(server);
  console.log(`port-e2e source ready: ${sourcePort}`);
  t.after(() => server.close());
  t.after(() => shutdownPersonalPortForwardBroker());

  const portScript = [
    '$listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)',
    '$listener.Start()',
    '$port=([System.Net.IPEndPoint]$listener.LocalEndpoint).Port',
    '$listener.Stop()',
    'Write-Output $port',
  ].join(';');
  const { stdout: portOutput } = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshTarget,
    `powershell -NoProfile -NonInteractive -Command "${portScript}"`,
  ], { timeout: 10_000 });
  const personalPort = Number(String(portOutput).trim().split(/\s+/).at(-1));
  assert.ok(Number.isInteger(personalPort) && personalPort >= 1024);
  console.log(`port-e2e Windows port reserved: ${personalPort}`);

  const forward = await openPersonalPortForward({
    ownerId: 'port-e2e-owner', bindingId: 'port-e2e-binding', sourceServerId: 'local',
    sourcePort, personalPort, label: 'port broker E2E', ttlMinutes: 2,
  });
  console.log(`port-e2e forward active: ${forward.id}`);
  t.after(() => closePersonalPortForward('port-e2e-owner', forward.id, 'port-e2e-binding').catch(() => undefined));
  assert.equal(forward.status, 'active');
  assert.equal(forward.localUrl, `http://127.0.0.1:${personalPort}`);

  const fetchScript = `(Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 http://127.0.0.1:${personalPort}).Content`;
  const { stdout } = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshTarget,
    `powershell -NoProfile -NonInteractive -Command "${fetchScript}"`,
  ], { timeout: 10_000 });
  console.log('port-e2e Windows fetch complete');
  assert.match(String(stdout), new RegExp(marker));

  const closed = await closePersonalPortForward('port-e2e-owner', forward.id, 'port-e2e-binding');
  console.log('port-e2e forward closed');
  assert.equal(closed.status, 'closed');
});
