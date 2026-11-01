export interface CodexAccountConnection {
  authenticated: boolean;
  type: 'chatgpt' | 'apiKey' | null;
  credentialId: string | null;
  credentialLabel: string | null;
  configured: boolean;
}

export interface CodexApiCredential {
  id: string;
  label: string;
  maskedSuffix: string;
  source: 'saved' | 'seed';
  createdAt: string;
}

interface AccountSnapshot {
  authenticated: boolean;
  type?: 'chatgpt' | 'apiKey' | null;
  credentialLabel?: string | null;
  email?: string | null;
  accountIdMasked?: string | null;
}

/** Older hosts return only device-flow state and do not expose API login routes. */
export function supportsCodexApiLogin(response: unknown): boolean {
  return response !== null && typeof response === 'object'
    && Object.prototype.hasOwnProperty.call(response, 'connection');
}

/** Native connection state is authoritative; ChatGPT quota may be from an older account. */
export function accountAuthenticationPresentation(
  account: AccountSnapshot | null | undefined,
  connection: CodexAccountConnection | null,
  profileLabel: string | null,
) {
  const authenticated = connection?.authenticated ?? account?.authenticated ?? false;
  const type = authenticated ? (connection?.type ?? account?.type ?? 'chatgpt') : null;
  const isApiKey = type === 'apiKey';
  const label = authenticated
    ? isApiKey
      ? connection?.credentialLabel || account?.credentialLabel || 'מפתח API'
      : account?.email || account?.accountIdMasked || profileLabel || 'Codex'
    : 'לא מחובר';
  return { authenticated, type, isApiKey, label, showChatgptUsage: !isApiKey };
}
