/** Keep account authentication inside the canonical persistent owner. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { resolveCodexSharedSocket } from './codexSharedSocket.mjs';
import {resolveCodexRuntimeProgram} from './codexRuntimePrograms.mjs';

export function getSharedAccountCommand(profile, action, fallbackBin, appRoot = process.env.CODEX_APP_ROOT || process.cwd()) {
  const sharedProfiles = new Set((process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES || '')
    .split(',').map((value) => value.trim()).filter(Boolean));
  if (!sharedProfiles.has(profile.id)) {
    return { bin: fallbackBin, args: action === 'login' ? ['login', '--device-auth']
      : action === 'api-key' ? ['login', '--with-api-key'] : action === 'read' ? ['login', 'status'] : ['logout'] };
  }
  const program = resolveCodexRuntimeProgram('accountAuth',{sourceRoot:appRoot});
  return { bin: process.execPath, args: [program, '--home', profile.codexHome, action] };
}

export async function runSharedAccountCommand(codexHome, action, { signal, onPrompt = () => {}, apiKey } = {}) {
  if (!['login', 'logout', 'read', 'api-key'].includes(action)) throw new Error('Unsupported account action');
  const endpoint = await resolveCodexSharedSocket(codexHome, process.getuid(), true);
  const ws = new WebSocket(`ws+unix://${endpoint.socketPath}:/`, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
  const pending = new Map(), completions = new Map();
  let nextId = 0, loginId = null, succeeded = false, waitCompletion = null, connectionError = null;
  const failConnection = () => {
    connectionError = new Error('Shared Codex account connection closed');
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(connectionError); }
    pending.clear();
    waitCompletion?.reject(connectionError);
  };
  ws.on('error', failConnection);
  ws.on('close', failConnection);
  ws.on('message', (bytes) => {
    let frame;
    try { frame = JSON.parse(bytes.toString()); } catch { return; }
    const entry = pending.get(frame.id);
    if (entry) {
      pending.delete(frame.id); clearTimeout(entry.timer);
      // Native errors can include HTTP auth context; expose only the action.
      if (frame.error) entry.reject(new Error(`Shared Codex ${entry.method} failed`));
      else entry.resolve(frame.result);
    } else if (frame.method === 'account/login/completed' && typeof frame.params?.loginId === 'string') {
      const completion = { loginId: frame.params.loginId, success: frame.params.success === true };
      if (completions.size < 64) completions.set(completion.loginId, completion);
      if (completion.loginId === loginId) waitCompletion?.resolve(completion);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error('Shared Codex account connection unavailable')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Shared Codex ${method} timed out`)); }, 5000);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
  let timeout, abortListener;
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve); ws.once('error', () => reject(new Error('Shared Codex account connection unavailable')));
    });
    const initialized = await call('initialize', { clientInfo: { name: 'code-ai-account-auth', version: '1' },
      capabilities: { experimentalApi: true } });
    if (initialized?.codexHome !== endpoint.codexHome) throw new Error('Shared Codex account owner mismatch');
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    if (signal?.aborted) throw new Error('Shared Codex login cancelled');
    if (action === 'read') {
      const result = await call('account/read', { refreshToken: false });
      const account = result?.account;
      return { type: account?.type === 'apiKey' || account?.type === 'chatgpt' ? account.type : null };
    }
    // A manual account action is refused while native work is active. Nothing
    // is interrupted, scheduled, retried, or resubmitted by this check.
    let cursor = null, pageCount = 0;
    do {
      const loaded = await call('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(loaded?.data) || ++pageCount > 100) throw new Error('Shared Codex active work status unavailable');
      for (const threadId of loaded.data) {
        if (typeof threadId !== 'string') throw new Error('Shared Codex active work status unavailable');
        const result = await call('thread/read', { threadId, includeTurns: false });
        if (result?.thread?.status?.type === 'active') throw new Error('Shared Codex account change failed: active work must finish first');
      }
      cursor = typeof loaded.nextCursor === 'string' ? loaded.nextCursor : null;
    } while (cursor);
    if (action === 'logout') {
      await call('account/logout', {});
      const account = await call('account/read', {refreshToken:false});
      if (account.account != null) throw new Error('Shared Codex logout account verification failed');
      return;
    }

    if (action === 'api-key') {
      if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 16384) {
        throw new Error('A saved API key is required');
      }
      const current = await call('account/read', { refreshToken: false });
      if (current?.account != null) throw new Error('Disconnect the current Codex account before API login');
      const result = await call('account/login/start', { type: 'apiKey', apiKey });
      if (result?.type !== 'apiKey') throw new Error('Shared Codex API login unavailable');
      const account = await call('account/read', { refreshToken: false });
      if (account?.account?.type !== 'apiKey') throw new Error('Shared Codex API login account verification failed');
      return { type: 'apiKey' };
    }

    const result = await call('account/login/start', { type: 'chatgptDeviceCode' });
    loginId = typeof result?.loginId === 'string' ? result.loginId : null;
    if (signal?.aborted) throw new Error('Shared Codex login cancelled');
    if (result?.type !== 'chatgptDeviceCode' || !loginId
        || result.verificationUrl !== 'https://auth.openai.com/codex/device'
        || typeof result.userCode !== 'string' || !/^[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+$/.test(result.userCode)) {
      throw new Error('Shared Codex device login unavailable');
    }
    onPrompt({ verificationUrl: result.verificationUrl, userCode: result.userCode });
    const completion = await new Promise((resolve, reject) => {
      waitCompletion = { resolve, reject };
      abortListener = () => reject(new Error('Shared Codex login cancelled'));
      signal?.addEventListener('abort', abortListener, { once: true });
      timeout = setTimeout(() => reject(new Error('Shared Codex login timed out')), 15 * 60 * 1000);
      if (signal?.aborted) abortListener();
      else if (connectionError) reject(connectionError);
      else if (completions.has(loginId)) resolve(completions.get(loginId));
    });
    if (!completion.success) throw new Error('Shared Codex login failed');
    const account=await call('account/read',{refreshToken:false});
    if(account.account?.type!=='chatgpt')throw new Error('Shared Codex login account verification failed');
    succeeded = true;
  } finally {
    clearTimeout(timeout);
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    waitCompletion = null;
    if (loginId && !succeeded && ws.readyState === WebSocket.OPEN) {
      await call('account/login/cancel', { loginId }).catch(() => {});
    }
    ws.terminate();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Shared Codex account connection closed')); }
    pending.clear();
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'codexSharedAccountAuth.mjs'
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--home');
  const home = index >= 0 ? process.argv[index + 1] : null;
  const action = process.argv.at(-1);
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  try {
    let apiKey;
    if (action === 'api-key') {
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 16384) throw new Error('Invalid API credential');
      }
      apiKey = input.trim();
    }
    const result = await runSharedAccountCommand(home, action, { signal: controller.signal, apiKey,
      onPrompt: ({ verificationUrl, userCode }) => process.stdout.write(
        `Open ${verificationUrl}\nEnter this one-time code: ${userCode}\n`) });
    process.stdout.write(action === 'read' ? `${JSON.stringify(result)}\n`
      : action === 'logout' ? 'Successfully logged out\n' : 'Successfully logged in\n');
  } catch (error) {
    const busy = error?.message === 'Shared Codex account change failed: active work must finish first';
    process.stderr.write(busy ? 'Account change failed: active work must finish first.\n' : 'Shared Codex account authentication failed.\n');
    process.exitCode = busy ? 2 : 1;
  }
}
