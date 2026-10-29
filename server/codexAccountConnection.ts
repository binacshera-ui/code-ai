import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CODEX_APP_CONFIG } from './config.js';
import { getSharedAccountCommand } from './codexSharedAccountAuth.mjs';
import type { CodexAccountUsageProfile } from './codexAccountUsage.js';

export interface CodexAccountConnection {
  authenticated: boolean;
  type: 'chatgpt' | 'apiKey' | null;
  credentialId: string | null;
  credentialLabel: string | null;
  /** Native login configures credentials; it does not verify funding or access. */
  configured: boolean;
}

const disconnected = (): CodexAccountConnection => ({ authenticated: false, type: null,
  credentialId: null, credentialLabel: null, configured: false });
const selectionPath = (profile: CodexAccountUsageProfile) => path.join(profile.codexHome, 'code-ai-api-connection.json');
const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex');

export async function readCodexStoredConnection(profile: CodexAccountUsageProfile): Promise<CodexAccountConnection> {
  let auth;
  try { auth = JSON.parse(await fs.readFile(path.join(profile.codexHome, 'auth.json'), 'utf8')); }
  catch { return disconnected(); }
  if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
    let selection;
    try { selection = JSON.parse(await fs.readFile(selectionPath(profile), 'utf8')); } catch {}
    const matches = selection?.keyFingerprint === fingerprint(auth.OPENAI_API_KEY);
    return { authenticated: true, type: 'apiKey', configured: true,
      credentialId: matches && typeof selection.credentialId === 'string' ? selection.credentialId : null,
      credentialLabel: matches && typeof selection.credentialLabel === 'string' ? selection.credentialLabel : null };
  }
  if (typeof auth?.tokens?.access_token === 'string' && auth.tokens.access_token) {
    return { ...disconnected(), authenticated: true, type: 'chatgpt', configured: true };
  }
  return disconnected();
}

export function hasSharedCodexAccountOwner(profile: CodexAccountUsageProfile): boolean {
  return (process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES || '').split(',').map(value => value.trim()).includes(profile.id);
}

/** The secret is sent through stdin, never argv, environment, output or errors. */
export async function runCodexCredentialCommand(profile: CodexAccountUsageProfile, action: 'read' | 'api-key', apiKey?: string): Promise<string> {
  const command = getSharedAccountCommand(profile, action, process.env.CODEX_BIN || 'codex', CODEX_APP_CONFIG.appRoot);
  return new Promise((resolve, reject) => {
    let output = '', settled = false;
    const child = spawn(command.bin, command.args, { cwd: profile.codexHome,
      env: { ...process.env, HOME: path.dirname(profile.codexHome), CODEX_HOME: profile.codexHome, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const fail = (busy = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error(busy ? 'יש להמתין לסיום המשימות הפעילות ולנסות שוב את החיבור הידני.'
        : action === 'read' ? 'לא ניתן לקרוא את חיבור Codex.' : 'החיבור באמצעות API נכשל. אפשר לנסות שוב לאחר בדיקת מצב החשבון.'));
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); fail(); }, 15_000);
    child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-16_384); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => fail());
    child.once('close', code => {
      if (code !== 0) { fail(code === 2 && hasSharedCodexAccountOwner(profile)); return; }
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(output);
    });
    child.stdin.end(action === 'api-key' ? `${apiKey || ''}\n` : undefined);
  });
}

export async function readCodexAccountConnection(profile: CodexAccountUsageProfile): Promise<CodexAccountConnection> {
  const stored = await readCodexStoredConnection(profile);
  if (!hasSharedCodexAccountOwner(profile)) return stored;
  const output = await runCodexCredentialCommand(profile, 'read');
  let native;
  try { native = JSON.parse(output); } catch { throw new Error('לא ניתן לקרוא את חיבור Codex.'); }
  if (native?.type === 'apiKey') return { ...stored, authenticated: true, type: 'apiKey', configured: true,
    credentialId: stored.type === 'apiKey' ? stored.credentialId : null,
    credentialLabel: stored.type === 'apiKey' ? stored.credentialLabel : null };
  return native?.type === 'chatgpt' ? { ...disconnected(), type: 'chatgpt', authenticated: true, configured: true } : disconnected();
}

export async function rememberCodexApiCredential(profile: CodexAccountUsageProfile, credential: { id: string; label: string }, apiKey: string): Promise<void> {
  const target = selectionPath(profile), temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ credentialId: credential.id, credentialLabel: credential.label,
      keyFingerprint: fingerprint(apiKey) }) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function clearCodexApiCredentialSelection(profile: CodexAccountUsageProfile): Promise<void> {
  await fs.rm(selectionPath(profile), { force: true });
}
