#!/usr/bin/env node
// One-time authorized rollout. Native work finishes before its owner restarts.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
const exec = promisify(execFile);
const settings = JSON.parse(await readFile(process.argv[2], 'utf8'));
const pending = new Map(settings.owners.map(owner => [owner.service, owner]));
const completed = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function inspect(owner, checkCatalog = false) {
  const ws = new WebSocket(`ws+unix://${owner.socket}:/`, { handshakeTimeout: 10000, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  const calls = new Map(); let next = 0;
  ws.on('error', () => {});
  ws.on('message', bytes => {
    let frame; try { frame = JSON.parse(bytes); } catch { return; }
    const call = calls.get(frame.id); if (!call) return;
    calls.delete(frame.id); clearTimeout(call.timer);
    frame.error ? call.reject(new Error('Native owner refused read')) : call.resolve(frame.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    calls.set(id, { resolve, reject, timer: setTimeout(() => { calls.delete(id); reject(new Error('Owner read timeout')); }, 10000) });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await Promise.race([new Promise((resolve,reject) => { ws.once('open',resolve); ws.once('error',reject); }), pause(10000).then(() => { throw new Error('Owner unavailable'); })]);
    await call('initialize', { clientInfo: { name: 'code-ai-inference-rollout', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    if (checkCatalog) {
      const config = await call('config/read', { includeLayers: false });
      if (config.config?.model_provider !== 'code_ai') throw new Error('Native owner did not load Code AI transport');
      const models = await call('model/list', { includeHidden: false });
      const slugs = models.data?.map(model => model.model || model.id) || [];
      if (!['gemini-4-argon','gemini-4-carbon','gemini-4-neon','gemini-4-hydrogen'].every(slug => slugs.includes(slug))) throw new Error('Native Gemini catalog incomplete');
      return true;
    }
    let cursor;
    do {
      const loaded = await call('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const threadId of loaded.data || []) {
        const snapshot = await call('thread/read', { threadId, includeTurns: false });
        const status = snapshot.thread?.status?.type;
        if (status === 'active' || !status) return false;
        const queued = await call('thread/queue/list', { threadId, limit: 1 });
        if (!Array.isArray(queued.data) || queued.data.length || queued.nextCursor) return false;
      }
      cursor = loaded.nextCursor;
    } while (cursor);
    return true;
  } finally {
    ws.terminate(); for (const call of calls.values()) clearTimeout(call.timer);
  }
}
while (pending.size) {
  for (const [service, owner] of pending) {
    try {
      if (!owner.restarted) {
      if (!await inspect(owner)) continue;
      await pause(1000);
      if (!await inspect(owner)) continue;
      await exec('systemctl', ['restart', service], { timeout: 45000 });
      owner.restarted = true;
      }
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try { await inspect(owner, true); ready = true; break; } catch { await pause(1000); }
      }
      if (!ready) throw new Error('Restarted owner readiness failed');
      completed.push({ service, at: new Date().toISOString(), ready: true }); pending.delete(service);
      await writeFile(settings.receipt, JSON.stringify({ completed, pending: [...pending.keys()] }, null, 2) + '\n', { mode: 0o600 });
      console.log('Code AI model transport activated for ' + service);
    } catch { console.log('Waiting for native owner readiness: ' + service); }
  }
  if (pending.size) await pause(3000);
}
