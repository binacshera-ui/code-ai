import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  closePersonalPortForward,
  openPersonalPortForward,
  shutdownPersonalPortForwardBroker,
} from './personalPortForwardBroker.js';

const execFileAsync = promisify(execFile);
const sourceSshTarget = process.env.CODE_AI_REMOTE_RELAY_TARGET || 'beam-10g';
const sourceServerId = process.env.CODE_AI_REMOTE_RELAY_SERVER_ID || 'beam-10g';
const personalSshTarget = process.env.CODE_AI_PERSONAL_SSH_TARGET || 'personal-windows-ssh';

function startRemoteHttp(marker: string): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  const program = [
    "const http=require('node:http')",
    `const marker=${JSON.stringify(marker)}`,
    "const server=http.createServer((_req,res)=>{res.setHeader('content-type','text/plain');res.end(marker)})",
    "server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,port:server.address().port})))",
    "process.on('SIGTERM',()=>server.close(()=>process.exit(0)))",
  ].join(';');
  const encodedProgram = Buffer.from(program, 'utf8').toString('base64');
  const remoteCommand = `node -e "eval(Buffer.from(process.argv[1],'base64').toString('utf8'))" ${encodedProgram}`;
  const child = spawn('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sourceSshTarget,
    remoteCommand,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error(`Remote HTTP startup timed out: ${stderr}`)), 10_000);
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve({ child, port: Number(port) });
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const line = stdout.split(/\r?\n/).find((entry) => entry.trim().startsWith('{'));
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.ready && Number.isInteger(parsed.port)) finish(undefined, parsed.port);
      } catch {
        // Wait for a complete JSON line.
      }
    };
    const onStderr = (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); };
    const onExit = (code: number | null) => finish(new Error(`Remote HTTP process exited with ${code}: ${stderr}`));
    const onError = (error: Error) => finish(error);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

test('port broker relays a remote-server loopback service to Windows loopback', { timeout: 45_000 }, async (t) => {
  const marker = `code-ai-remote-port-e2e-${Date.now()}`;
  const remote = await startRemoteHttp(marker);
  console.log(`remote-port-e2e source ready: ${sourceServerId}:${remote.port}`);
  t.after(() => {
    if (!remote.child.killed) remote.child.kill('SIGTERM');
  });
  t.after(() => shutdownPersonalPortForwardBroker());

  const reserveScript = [
    '$listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)',
    '$listener.Start()',
    '$port=([System.Net.IPEndPoint]$listener.LocalEndpoint).Port',
    '$listener.Stop()',
    'Write-Output $port',
  ].join(';');
  const { stdout: portOutput } = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', personalSshTarget,
    `powershell -NoProfile -NonInteractive -Command "${reserveScript}"`,
  ], { timeout: 10_000 });
  const personalPort = Number(String(portOutput).trim().split(/\s+/).at(-1));
  assert.ok(Number.isInteger(personalPort) && personalPort >= 1024);

  const forward = await openPersonalPortForward({
    ownerId: 'remote-port-e2e-owner',
    bindingId: 'remote-port-e2e-binding',
    sourceServerId,
    sourcePort: remote.port,
    personalPort,
    label: 'remote port broker E2E',
    ttlMinutes: 2,
  });
  t.after(() => closePersonalPortForward('remote-port-e2e-owner', forward.id, 'remote-port-e2e-binding').catch(() => undefined));
  assert.equal(forward.status, 'active');

  const fetchScript = `(Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 http://127.0.0.1:${personalPort}).Content`;
  const { stdout } = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', personalSshTarget,
    `powershell -NoProfile -NonInteractive -Command "${fetchScript}"`,
  ], { timeout: 12_000 });
  assert.match(String(stdout), new RegExp(marker));

  const closed = await closePersonalPortForward('remote-port-e2e-owner', forward.id, 'remote-port-e2e-binding');
  assert.equal(closed.status, 'closed');
  console.log(`remote-port-e2e complete: ${sourceServerId}:${remote.port} -> Windows:${personalPort}`);
});
