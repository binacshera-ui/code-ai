const DEFAULT_BINA_LEGACY_AUTH_ORIGIN = 'http://127.0.0.1:9001';
export const BINA_FORUM_SESSION_COOKIE = 'forum.session';

export type BinaSessionPrincipalType = 'customer' | 'forum';

export interface BinaSessionValidationResult {
  authenticated: boolean;
  principalType: BinaSessionPrincipalType | null;
}

export function readRawCookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  for (const cookiePart of cookieHeader.split(';')) {
    const separator = cookiePart.indexOf('=');
    if (separator < 1) continue;
    const name = cookiePart.slice(0, separator).trim();
    if (name !== cookieName) continue;
    const value = cookiePart.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

export function isSafeForumSessionCookie(value: string | null): value is string {
  return Boolean(
    value
    && value.length >= 16
    && value.length <= 8192
    && !/[\r\n\0;]/.test(value),
  );
}

export function resolveBinaMainAppOrigin(
  configuredOrigin = process.env.BINA_LEGACY_AUTH_ORIGIN || process.env.BINA_MAIN_APP_ORIGIN,
): string {
  const rawOrigin = configuredOrigin?.trim() || DEFAULT_BINA_LEGACY_AUTH_ORIGIN;
  const parsed = new URL(rawOrigin);
  const hostname = parsed.hostname.toLowerCase();
  const isBinaHost = hostname === 'bina-cshera.co.il' || hostname.endsWith('.bina-cshera.co.il');
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('BINA_MAIN_APP_ORIGIN must be a plain origin without credentials, query or fragment');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('BINA_MAIN_APP_ORIGIN must use HTTPS (HTTP is allowed only for loopback tests)');
  }
  if (!isBinaHost && !isLoopback) {
    throw new Error('BINA_MAIN_APP_ORIGIN must point to a Bina Cshera or loopback host');
  }

  return parsed.origin;
}

async function readJsonSafely(response: Response) {
  return response.json().catch(() => null) as Promise<any>;
}

export async function validateBinaForumSession(
  forumSession: string,
  options: {
    fetchImpl?: typeof fetch;
    origin?: string;
    timeoutMs?: number;
  } = {},
): Promise<BinaSessionValidationResult> {
  if (!isSafeForumSessionCookie(forumSession)) {
    return { authenticated: false, principalType: null };
  }

  const origin = resolveBinaMainAppOrigin(options.origin);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs || 5_000, 15_000));
  const candidates: Array<{
    path: string;
    principalType: BinaSessionPrincipalType;
    accepts: (payload: any) => boolean;
  }> = [
    {
      path: '/api/customer/auth/me',
      principalType: 'customer',
      accepts: (payload) => Boolean(payload?.customer?.id),
    },
    {
      path: '/api/auth/me',
      principalType: 'forum',
      accepts: (payload) => payload?.success === true && Boolean(payload?.user?.id),
    },
  ];

  for (const candidate of candidates) {
    const response = await fetchImpl(`${origin}${candidate.path}`, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Cookie: `${BINA_FORUM_SESSION_COOKIE}=${forumSession}`,
        'User-Agent': 'Code-AI-Workbench-SSO/1.0',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 200) {
      const payload = await readJsonSafely(response);
      if (candidate.accepts(payload)) {
        return { authenticated: true, principalType: candidate.principalType };
      }
      continue;
    }

    if (![401, 403, 404].includes(response.status)) {
      throw new Error(`Bina session verification failed with status ${response.status}`);
    }
  }

  return { authenticated: false, principalType: null };
}
