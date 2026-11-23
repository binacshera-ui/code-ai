import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import { promises as fs } from 'fs';

const WORKBENCH_SSO_PROTOCOL = 'bina-workbench-sso-v1';
const WORKBENCH_SSO_PATH = '/api/runtime/internal/workbench-sso/session';
const DEFAULT_INTERNAL_ORIGIN = 'http://127.0.0.1:46120';
const DEFAULT_PUBLIC_AUDIENCE = 'https://app.bina-cshera.co.il';

function resolveLoopbackOrigin(configuredOrigin = process.env.BINA_RUNTIME_INTERNAL_ORIGIN) {
  const parsed = new URL(configuredOrigin?.trim() || DEFAULT_INTERNAL_ORIGIN);
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase());
  if (!isLoopback || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('BINA_RUNTIME_INTERNAL_ORIGIN must be a loopback HTTP(S) origin');
  }
  return parsed.origin;
}

async function readWorkbenchSsoSecret(configuredPath = process.env.BINA_WORKBENCH_SSO_SECRET_FILE) {
  const secretPath = configuredPath?.trim() || '';
  if (!secretPath) throw new Error('BINA_WORKBENCH_SSO_SECRET_FILE is required');
  const stats = await fs.stat(secretPath);
  if (!stats.isFile()) throw new Error('BINA_WORKBENCH_SSO_SECRET_FILE must be a regular file');
  if ((stats.mode & 0o077) !== 0) {
    throw new Error('BINA_WORKBENCH_SSO_SECRET_FILE must not be accessible by group or others');
  }
  const secret = (await fs.readFile(secretPath, 'utf-8')).trim();
  if (Buffer.byteLength(secret, 'utf-8') < 32 || secret.includes('\0')) {
    throw new Error('The Workbench SSO secret must contain at least 32 bytes');
  }
  return secret;
}

function buildSignature(input: {
  body: Buffer;
  nonce: string;
  secret: string;
  timestamp: string;
}) {
  const canonical = [
    WORKBENCH_SSO_PROTOCOL,
    'POST',
    WORKBENCH_SSO_PATH,
    input.timestamp,
    input.nonce,
    createHash('sha256').update(input.body).digest('base64url'),
  ].join('\n');
  return createHmac('sha256', input.secret).update(canonical).digest('base64url');
}

export async function issueBinaRuntimeWorkbenchSession(
  input: { profileId: string; sessionKey: string },
  options: {
    fetchImpl?: typeof fetch;
    internalOrigin?: string;
    publicAudience?: string;
    secret?: string;
    secretFile?: string;
    timeoutMs?: number;
  } = {},
) {
  const secret = options.secret || await readWorkbenchSsoSecret(options.secretFile);
  const internalOrigin = resolveLoopbackOrigin(options.internalOrigin);
  const publicAudience = new URL(options.publicAudience || DEFAULT_PUBLIC_AUDIENCE).origin;
  if (publicAudience !== DEFAULT_PUBLIC_AUDIENCE) {
    throw new Error('The Bina runtime SSO audience is not allowed');
  }

  const body = Buffer.from(JSON.stringify({
    audience: publicAudience,
    requestId: randomUUID(),
    workbenchSessionHash: createHash('sha256')
      .update(`${input.profileId}\0${input.sessionKey}`)
      .digest('hex'),
  }));
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(24).toString('base64url');
  const signature = buildSignature({ body, nonce, secret, timestamp });
  const response = await (options.fetchImpl || fetch)(`${internalOrigin}${WORKBENCH_SSO_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Bina-Workbench-Nonce': nonce,
      'X-Bina-Workbench-Signature': signature,
      'X-Bina-Workbench-Timestamp': timestamp,
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(Math.max(500, Math.min(options.timeoutMs || 5_000, 15_000))),
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Bina runtime SSO failed with status ${response.status}`);
  }
  const runtimeSession = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runtimeSession)) {
    throw new Error('Bina runtime SSO returned an invalid session');
  }

  return {
    runtimeSession,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
  };
}
