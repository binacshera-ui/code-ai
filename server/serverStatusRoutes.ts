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
      res.json(await readStatus());
    } catch {
      res.status(503).json({ error: 'מדדי השרת אינם זמינים כרגע. ניתן לנסות שוב.', code: 'SERVER_STATUS_UNAVAILABLE' });
    }
  });
  return router;
}
