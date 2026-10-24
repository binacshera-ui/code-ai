import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function fleetClient() {
  const release = path.dirname(await fs.realpath('/root/projects/code-ai/dist'));
  const request = JSON.parse(await fs.readFile(release + '/fleet-request.json', 'utf8'));
  const { preserveRuntimeAuthentication } = await import(pathToFileURL(release + '/runtime-auth.mjs'));
  const env = { CODE_AI_AUTH_BASELINE_MODULE: request.authenticationBaselineModule,
    CODE_AI_AUTH_BASELINE_SHA256: request.authenticationBaselineSha256 };
  await preserveRuntimeAuthentication(env);
  const response = await fetch('http://127.0.0.1:4000/api/codex/device-unlock', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: env.CODEX_DEVICE_ADMIN_PASSWORD }),
    signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  return async function api(serverId, route, body) {
    for(let attempt=0;attempt<2;attempt++){
    const response = await fetch('http://127.0.0.1:4000/api/codex' + route, {
      headers: { 'content-type': 'application/json', cookie, 'x-code-ai-server-id': serverId },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(65_000),
    });
    const value = await response.json();
    if(body===undefined&&attempt===0&&[502,503,504].includes(response.status)){
      await new Promise(resolve=>setTimeout(resolve,1200));continue;
    }
    if (!response.ok) throw new Error(`Code AI ${serverId} ${route.split('?')[0]} HTTP ${response.status}`);
    return value;
    }
  };
}

export async function inventory(api) {
  const registry = JSON.parse(await fs.readFile('/root/projects/code-ai/.code-ai/remote-hosts.json', 'utf8'));
  return Promise.all(['local', ...registry.hosts.filter(host => host.enabled).map(host => host.id)].map(async id => {
    try {
      const health = await api(id, '/remote-agent/health');
      return { id, reachable: health.ok === true, version: health.version, ready: health.ready,
        hostname: health.hostname, profiles: (health.profiles || []).map(profile => ({
          id: profile.id, provider: profile.provider, mode: profile.mode, codexVersion: profile.codexVersion,
          authenticated: profile.authenticated, transportReady: profile.transportReady, versionMatched: profile.versionMatched,
        })) };
    } catch (error) { return { id, reachable: false, error: error.message }; }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const api = await fleetClient();
  const results = await inventory(api);
  const report = { checkedAt: new Date().toISOString(), results };
  if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
