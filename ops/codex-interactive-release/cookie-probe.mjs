// Isolated browser proof of the real SameSite cookie contract, with no injection
// of authentication on asset requests. Never points at installed storage/accounts.
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { createInteractiveFixture } from './api-smoke.mjs';
const compiled = path.resolve(process.argv[2] || '');
if (!compiled.startsWith('/mnt/hdd/code-ai-builds/codex-interactive-imports/')) throw Error('Imported build required');
const fixture = await createInteractiveFixture(compiled, undefined, { timeoutMs: 1_800_000 });
await fixture.start();
await fixture.request('/api/codex/device-unlock', 'POST', { password: fixture.devicePassword });
const token = Buffer.from(fixture.assets.html).toString('base64url');
const asset = `/api/codex/files/asset/local/${token}/index.html`;
const cookieName = 'code_ai_qa_probe_93cb';
const ownValue = fixture.cookie.slice(fixture.cookie.indexOf('=') + 1);
const observations = [];
const gateway = http.createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store',
      // Namespace-only scope cannot overwrite a real root-path device cookie.
      'set-cookie': `${cookieName}=${ownValue}; HttpOnly; Path=${path.dirname(asset)}/; SameSite=Lax; Max-Age=600` });
    response.end(`<!doctype html><html><body><h1>Isolated SameSite proof</h1><iframe sandbox="allow-scripts" src="${asset}" style="width:80vw;height:70vh"></iframe><script>window.probeEvents=[];window.addEventListener('message',e=>{if(e.data?.fixturePreview)probeEvents.push(e.data)});</script></body></html>`);
    return;
  }
  if (request.url === '/__probe/metadata') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ observations, realAccounts:false, productionEffects:false }));
    return;
  }
  const headers = { ...request.headers, host: `127.0.0.1:${fixture.port}` };
  delete headers.authorization;
  delete headers['x-forwarded-host'];
  // Translate only the namespace-scoped synthetic browser cookie. Never forward
  // other cookies, never inject authentication when the browser omits this one.
  const scoped = (request.headers.cookie || '').split(';').map(part=>part.trim())
    .find(part=>part.startsWith(`${cookieName}=`));
  if (scoped) headers.cookie = `code_ai_device_unlock=${scoped.slice(cookieName.length + 1)}`;
  else delete headers.cookie;
  const upstream = http.request(fixture.origin + request.url, { method:request.method, headers }, result => {
    if (request.url?.startsWith('/api/codex/files/asset/')) observations.push({
      extension: path.extname(request.url.split('?')[0]), status:result.statusCode,
      cookiePresent: !!scoped,
    });
    const forwarded = { ...result.headers };delete forwarded['set-cookie'];
    response.writeHead(result.statusCode || 502, forwarded);result.pipe(response);
  });
  upstream.on('error',()=>{response.writeHead(502);response.end('Probe upstream unavailable');});
  request.pipe(upstream);
});
const requestedPort = Number(process.argv[3] || 0);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw Error('Invalid probe port');
gateway.listen(requestedPort,'127.0.0.1');await once(gateway,'listening');
console.log(JSON.stringify({port:gateway.address().port,host:'code-ai-interactive-cookie-93cb.localhost',realAccounts:false,productionEffects:false}));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;gateway.closeAllConnections();gateway.close();await fixture.stop();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);setTimeout(stop,1_700_000).unref();
