// QA only: a loopback gateway to a synthetic, isolated, already compiled backend.
// Never use with production storage or a real provider account.
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, cp, writeFile } from 'node:fs/promises';
import { createInteractiveFixture } from './api-smoke.mjs';

const compiledServer = path.resolve(process.argv[2] || '');
if (!compiledServer.startsWith('/mnt/hdd/code-ai-builds/codex-interactive-imports/')) {
  throw new Error('An imported qualification build is required');
}
const fixture = await createInteractiveFixture(compiledServer, undefined, { timeoutMs: 3_600_000 });
// The existing UI gate checks for this file's existence. Empty synthetic JSON
// contains no usable account credential, and only the guarded fake CLI can run.
await writeFile(path.join(fixture.home, 'auth.json'), '{}\n', { mode: 0o600 });
await fixture.start();
await fixture.request('/api/codex/device-unlock', 'POST', { password: fixture.devicePassword });
// Reproduce the user's image with a private copy in the fixture's permitted roots.
await cp('/root/projects/business/projects/05/design-lab/dab-crm/screenshots/crm-exact-rtl.png', fixture.assets.png);
await cp('/root/projects/business/projects/05/design-lab/dab-crm/DAB-CRM-preview.html', path.join(fixture.cwd, 'demo', 'DAB-CRM-preview.html'));
const queued = await fixture.request('/api/codex/queue/items', 'POST', {
  profileId: fixture.profileId, cwd: fixture.cwd, queueKey: 'isolated-real-browser-qualification',
  clientRequestId: randomUUID(), prompt: 'בדיקת ממשק מבודדת: בחירה באמצע משימה, טקסט חופשי ותצוגת קבצים.',
}, 202);
const itemId = queued.item.id;
const item = await fixture.poll(async () => {
  const { item: current } = await fixture.request(`/api/codex/queue/items/${itemId}?includeSession=false`);
  return current.sessionId && current.status === 'running' ? current : false;
});
const sessionPath = `/session/${fixture.profileId}/${item.sessionId}`;
// A unique, browser-owned cookie proves SameSite behavior. Never inject auth on
// requests lacking it, and never touch/forward a real device-unlock cookie.
const cookieName = `code_ai_qa_${randomUUID().replaceAll('-', '')}`;
const ownValue = fixture.cookie.slice(fixture.cookie.indexOf('=') + 1);
const assetObservations = [];
const gateway = http.createServer(async (request, response) => {
  try {
    if (request.url === '/__qa/status') {
      const { item: current } = await fixture.request(`/api/codex/queue/items/${itemId}?includeSession=false`);
      const input = await fixture.request(`/api/codex/sessions/${item.sessionId}/user-input?profile=${fixture.profileId}`);
      const audit = JSON.parse(await readFile(path.join(fixture.home, '.fixture-audit.json'), 'utf8'));
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ sessionPath, queueStatus: current?.status, attempts: current?.attempts,
        requestStatuses: input.requests.map(entry => ({ status: entry.status, isBlocking: entry.isBlocking })),
        nativeTurns: audit.turnStartCount, nativeAnswers: audit.answerCount,
        assetObservations,
        realAccounts: false, productionEffects: false }));
      return;
    }
    const scoped = (request.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${cookieName}=`));
    const isLanding = request.method === 'GET' && request.url === sessionPath;
    const headers = { ...request.headers, host: `127.0.0.1:${fixture.port}` };
    delete headers.authorization;
    delete headers['x-forwarded-host'];
    if (scoped) headers.cookie = `code_ai_device_unlock=${scoped.slice(cookieName.length + 1)}`;
    else delete headers.cookie;
    const upstream = http.request(fixture.origin + request.url, { method: request.method, headers }, result => {
      if (request.url?.startsWith('/api/codex/files/asset/') || request.url?.startsWith('/api/codex/files/content?')) {
        assetObservations.push({extension:path.extname(request.url.split('?')[0]),
          namespace:request.url.includes('/asset/'),status:result.statusCode,cookiePresent:!!scoped});
      }
      const forwardedHeaders = { ...result.headers };
      delete forwardedHeaders['set-cookie'];
      if (isLanding) forwardedHeaders['set-cookie'] = `${cookieName}=${ownValue}; HttpOnly; Path=/; SameSite=Lax; Max-Age=1800`;
      response.writeHead(result.statusCode || 502, forwardedHeaders);
      result.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end('Isolated QA upstream unavailable'); });
    request.pipe(upstream);
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Isolated QA gateway failed' }));
  }
});
const requestedPort = Number(process.argv[3] || 0);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid QA port');
gateway.listen(requestedPort, '127.0.0.1');
await once(gateway, 'listening');
console.log(JSON.stringify({ port: gateway.address().port, sessionPath, realAccounts: false, productionEffects: false }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  gateway.closeAllConnections();
  gateway.close();
  await fixture.stop();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setTimeout(stop, 3_500_000).unref();
