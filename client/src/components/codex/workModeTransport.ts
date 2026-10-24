import type {WorkModePreferences} from './workModePreferences';

export type WorkModeRequest = <T>(serverId: string, input: RequestInfo, init?: RequestInit) => Promise<T>;

/** The deployed endpoint requires the engineering fields even for other modes.
 * Read them immediately before saving; omit unrelated optional fields so the
 * server preserves its current values rather than replaying a stale UI snapshot.
 * Never send after navigation invalidates the caller's scoped write ticket.
 */
export async function saveWorkModePreferences(
  request: WorkModeRequest,
  serverId: string,
  profileId: string,
  sessionKey: string,
  patch: Partial<WorkModePreferences>,
  isCurrent: () => boolean,
): Promise<WorkModePreferences | null> {
  if (!profileId || !sessionKey || !isCurrent()) return null;
  const route = '/api/codex/session-focus-mode';
  const query = new URLSearchParams({profileId, sessionKey});
  const {focusMode: current} = await request<{focusMode: WorkModePreferences}>(
    serverId, `${route}?${query}`, {cache: 'no-store'},
  );
  if (!isCurrent()) return null;
  if (typeof current?.enabled !== 'boolean' || typeof current?.goal !== 'string') {
    throw new Error('לא ניתן לאמת את הגדרות המצב הקיימות; השינוי לא נשלח');
  }
  const {focusMode} = await request<{focusMode: WorkModePreferences}>(serverId, route, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({profileId, sessionKey, focusMode: {enabled: current.enabled, goal: current.goal, ...patch}}),
  });
  return isCurrent() ? focusMode : null;
}
