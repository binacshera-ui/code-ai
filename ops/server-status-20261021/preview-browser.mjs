import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const ops = '/root/projects/code-ai/ops/server-status-20261021';
const stage = JSON.parse(await fs.readFile(ops + '/staged.json', 'utf8'));
const release = '/var/www/code-ai-ui/releases/' + stage.sourceSha256.slice(0, 12);
const scratch = await fs.mkdtemp('/mnt/hdd/code-ai-builds/server-status-browser-preview-');
await fs.chmod(scratch, 0o755);
await fs.writeFile(scratch + '/nginx.conf', `user www-data;\npid ${scratch}/nginx.pid;\nerror_log ${scratch}/error.log;\nevents {}\nhttp { include /etc/nginx/mime.types; access_log off; server { listen 127.0.0.1:47984; include ${release}/locations.conf; location / { proxy_pass http://127.0.0.1:4000; } } }\n`);
const proc = spawn('/usr/sbin/nginx', ['-p', scratch, '-c', scratch + '/nginx.conf', '-g', 'daemon off;'], { stdio: 'ignore' });
const ended = new Promise(resolve => proc.on('exit', resolve));
try {
  let ready = false;
  for (let i = 0; i < 30; i++) { try { const r = await fetch('http://127.0.0.1:47984/'); if (r.ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready);
  const child = spawn(process.execPath, [ops + '/browser-check.mjs'], { env: { ...process.env, CODE_AI_STATUS_TEST_ORIGIN: 'http://127.0.0.1:47984' }, stdio: 'inherit' });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
  await fs.copyFile(ops + '/browser-check.json', ops + '/preview-browser.json');
} finally { proc.kill('SIGQUIT'); await ended; }
