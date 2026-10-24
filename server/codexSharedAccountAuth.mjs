/** Keep managed ChatGPT login/logout inside the canonical persistent owner. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { resolveCodexSharedSocket } from './codexSharedSocket.mjs';
import {resolveCodexRuntimeProgram} from './codexRuntimePrograms.mjs';

export function getSharedAccountCommand(profile, action, fallbackBin, appRoot = process.env.CODEX_APP_ROOT || process.cwd()) {
  const sharedProfiles = new Set((process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES || '')
    .split(',').map((value) => value.trim()).filter(Boolean));
  if (!sharedProfiles.has(profile.id)) {
    return { bin: fallbackBin, args: action === 'login' ? ['login', '--device-auth'] : ['logout'] };
  }
  const program = resolveCodexRuntimeProgram('accountAuth',{sourceRoot:appRoot});
  return { bin: process.execPath, args: [program, '--home', profile.codexHome, action] };
}

export async function runSharedAccountCommand(codexHome, action, { signal, onPrompt = () => {} } = {}) {
  if (!['login', 'logout'].includes(action)) throw new Error('Unsupported account action');
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
    if (action === 'logout') {
      await call('account/logout', {});
      const account = await call('account/read', {refreshToken:false});
      if (account.account != null) throw new Error('Shared Codex logout account verification failed');
      return;
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
    await runSharedAccountCommand(home, action, { signal: controller.signal,
      onPrompt: ({ verificationUrl, userCode }) => process.stdout.write(
        `Open ${verificationUrl}\nEnter this one-time code: ${userCode}\n`) });
    process.stdout.write(action === 'login' ? 'Successfully logged in\n' : 'Successfully logged out\n');
  } catch {
    process.stderr.write('Shared Codex account authentication failed.\n');
    process.exitCode = 1;
  }
}
