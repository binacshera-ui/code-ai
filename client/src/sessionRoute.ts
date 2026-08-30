export type SessionRouteKind = 'session' | 'draft';
export type SessionRouteSurface = 'workbench' | 'chat';

export interface SessionRoute {
  profileId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  draftKey: string | null;
  kind: SessionRouteKind | null;
  source: 'path' | 'query';
}

type SessionRouteLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;

const SAFE_ROUTE_TOKEN = /^[a-zA-Z0-9:._-]{1,240}$/;
const TEST_ORIGIN = 'https://code-ai.invalid';

function safeDecodeRouteToken(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    return SAFE_ROUTE_TOKEN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function safeQueryRouteToken(value: string | null): string | null {
  const normalized = value?.trim() || '';
  return normalized && SAFE_ROUTE_TOKEN.test(normalized) ? normalized : null;
}

function toRouteUrl(input?: string | SessionRouteLocation): URL | null {
  if (typeof input === 'string') {
    try {
      return new URL(input, TEST_ORIGIN);
    } catch {
      return null;
    }
  }
  if (input) {
    return new URL(`${input.pathname}${input.search}${input.hash || ''}`, TEST_ORIGIN);
  }
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href);
}

export function readSessionRoute(input?: string | SessionRouteLocation): SessionRoute | null {
  const url = toRouteUrl(input);
  if (!url) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const sessionMarkerIndex = segments.indexOf('session');
  if (sessionMarkerIndex >= 0) {
    const profileId = safeDecodeRouteToken(segments[sessionMarkerIndex + 1]);
    const draftRoute = segments[sessionMarkerIndex + 2] === 'draft';
    const sessionKey = safeDecodeRouteToken(
      segments[sessionMarkerIndex + (draftRoute ? 3 : 2)]
    );
    if (profileId && sessionKey) {
      return {
        profileId,
        sessionKey,
        sessionId: draftRoute ? null : sessionKey,
        draftKey: draftRoute ? sessionKey : null,
        kind: draftRoute ? 'draft' : 'session',
        source: 'path',
      };
    }
  }

  const profileId = safeQueryRouteToken(url.searchParams.get('profile'));
  const sessionId = safeQueryRouteToken(url.searchParams.get('session'));
  const draftKey = safeQueryRouteToken(url.searchParams.get('draft'));
  if (!profileId && !sessionId && !draftKey) return null;
  const sessionKey = sessionId || draftKey;
  return {
    profileId,
    sessionKey,
    sessionId,
    draftKey: sessionId ? null : draftKey,
    kind: sessionId ? 'session' : draftKey ? 'draft' : null,
    source: 'query',
  };
}

export function getSessionRouteSurface(input?: string | SessionRouteLocation): SessionRouteSurface {
  const url = toRouteUrl(input);
  return url?.pathname === '/chat' || url?.pathname.startsWith('/chat/') ? 'chat' : 'workbench';
}

export function buildSessionPath(
  profileId: string,
  sessionKey: string,
  kind: SessionRouteKind,
  surface: SessionRouteSurface = 'workbench'
): string {
  const prefix = surface === 'chat' ? '/chat' : '';
  const encodedProfileId = encodeURIComponent(profileId);
  const encodedSessionKey = encodeURIComponent(sessionKey);
  return kind === 'draft'
    ? `${prefix}/session/${encodedProfileId}/draft/${encodedSessionKey}`
    : `${prefix}/session/${encodedProfileId}/${encodedSessionKey}`;
}

export function buildSessionHref(
  currentHref: string,
  profileId: string | null,
  sessionKey: string | null,
  kind: SessionRouteKind | null,
  surface?: SessionRouteSurface
): string {
  const url = new URL(currentHref, TEST_ORIGIN);
  const resolvedSurface = surface || getSessionRouteSurface(url.href);
  if (profileId && sessionKey && kind) {
    url.pathname = buildSessionPath(profileId, sessionKey, kind, resolvedSurface);
  } else {
    url.pathname = resolvedSurface === 'chat' ? '/chat' : '/';
  }
  url.searchParams.delete('profile');
  url.searchParams.delete('session');
  url.searchParams.delete('draft');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function replaceCurrentSessionRoute(
  profileId: string | null,
  sessionKey: string | null,
  kind: SessionRouteKind | null,
  surface?: SessionRouteSurface
): void {
  if (typeof window === 'undefined') return;
  const nextHref = buildSessionHref(window.location.href, profileId, sessionKey, kind, surface);
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextHref === currentHref) return;
  window.history.replaceState(window.history.state, '', nextHref);
}
