import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

interface AccountModel { slug: string; additional_speed_tiers?: unknown; service_tiers?: unknown; [key: string]: unknown }
interface Auth { auth_mode?: string; OPENAI_API_KEY?: string; tokens?: { account_id?: string; access_token?: string } }
async function auth(home: string): Promise<Auth> {
  try { return JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')); } catch { return {}; }
}
function scope(value: Auth): string {
  return createHash('sha256').update(JSON.stringify([value.auth_mode, value.tokens?.account_id, value.OPENAI_API_KEY])).digest('hex');
}
export async function readCodexCatalogAccountScope(home: string): Promise<string> { return scope(await auth(home)); }

/** Refresh the managed Gemini overlay from this account's real model catalog.
 * A failed lookup never grants Ultrafast from another login's local overlay. */
export async function refreshCodexAccountModels(home: string, expectedScope: string,
  options: { fetchImpl?: typeof fetch; clientVersion?: string } = {}): Promise<AccountModel[] | null> {
  const before = await auth(home);
  if (scope(before) !== expectedScope || !before.tokens?.account_id || !before.tokens?.access_token
      || ['apikey', 'api_key', 'api-key'].includes((before.auth_mode || '').toLowerCase())) return null;
  try {
    const response = await (options.fetchImpl || fetch)(
      'https://chatgpt.com/backend-api/codex/models?client_version=' + encodeURIComponent(options.clientVersion || '0.171.0'), {
        headers: { Authorization: `Bearer ${before.tokens.access_token}`, 'ChatGPT-Account-ID': before.tokens.account_id },
        signal: AbortSignal.timeout(8_000),
      });
    if (!response.ok) return null;
    const payload = await response.json();
    const models: AccountModel[] = payload?.models;
    if (!Array.isArray(models) || !models.length || models.some(m => !m || typeof m.slug !== 'string' || !m.slug.trim())) return null;
    if (scope(await auth(home)) !== expectedScope) return null;
    const config = (await fs.readFile(path.join(home, 'config.toml'), 'utf8')).split(/^\s*\[/m)[0];
    const configured = config.match(/^\s*model_catalog_json\s*=\s*("(?:\\.|[^"\\])*")\s*$/m)?.[1];
    const managed = path.join(home, 'code-ai-models.json');
    if (configured && path.resolve(JSON.parse(configured)) === path.resolve(managed)) {
      const current = JSON.parse(await fs.readFile(managed, 'utf8'));
      const aliases = (current.models || []).filter((m: AccountModel) => typeof m.slug === 'string' && m.slug.startsWith('gemini-'));
      const bytes = JSON.stringify({ models: [...models, ...aliases] }, null, 2) + '\n';
      if (bytes !== JSON.stringify(current, null, 2) + '\n') {
        const metadata = await fs.stat(managed);
        const temporary = managed + '.' + randomUUID() + '.tmp';
        try {
          await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
          await fs.chown(temporary, metadata.uid, metadata.gid);
          if (scope(await auth(home)) !== expectedScope) return null;
          await fs.rename(temporary, managed);
        } finally { await fs.unlink(temporary).catch(() => {}); }
      }
    }
    return models;
  } catch { return null; }
}
