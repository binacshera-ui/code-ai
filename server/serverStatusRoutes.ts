import { Router, type RequestHandler } from 'express';
import { getServerStatus } from './serverStatus.js';
import type { ServerStatusSnapshot } from '../shared/serverStatus.js';

export function createServerStatusRouter(
  requireAccess: RequestHandler,
  readStatus: () => Promise<ServerStatusSnapshot> = getServerStatus,
) {
  const router = Router();
  router.get('/server-status', requireAccess, async (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    try {
      const snapshot = await readStatus();
      if (['cpu', 'memory', 'storage', 'network'].every(key => snapshot[key as keyof ServerStatusSnapshot] === null)) {
        throw new Error('All monitoring collectors are unavailable');
      }
      res.json(snapshot);
    } catch {
      res.status(503).json({ error: 'מדדי השרת אינם זמינים כרגע. ניתן לנסות שוב.', code: 'SERVER_STATUS_UNAVAILABLE' });
    }
  });
  return router;
}
