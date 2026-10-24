import type { ServerStatusSnapshot } from '../../../../shared/serverStatus';

export async function readServerStatus(
  request: (signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<ServerStatusSnapshot> {
  const response = await request(signal);
  if (response.status === 404) {
    throw new Error('מצב שרת אינו נתמך עדיין בגרסה המותקנת בשרת שנבחר.');
  }
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? 'נדרשת התחברות מחדש כדי לצפות במצב השרת.'
      : 'לא ניתן לקרוא מדדים מהשרת שנבחר כרגע. נסה שוב.');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('השרת שנבחר אינו מחזיר מדדי ניטור תואמים.');
  }
  const snapshot = await response.json() as ServerStatusSnapshot;
  if (snapshot.version !== 1 || !snapshot.hostname || !Number.isFinite(Date.parse(snapshot.sampledAt))
    || !Array.isArray(snapshot.warnings) || !('storage' in snapshot) || !('cpu' in snapshot)
    || !('memory' in snapshot) || !('network' in snapshot)) {
    throw new Error('מדדי השרת התקבלו בתבנית לא תואמת.');
  }
  return snapshot;
}
