import { Router, type RequestHandler } from 'express';
import { controlWorkModeRun } from './codexWorkModeRuntime.js';
import { listRationalRuns, releaseRationalRun } from './codexRationalMode.js';

/** Run-scoped local capability, independent of the sidecar's administrative token. */
export function createWorkModeControlHandler(control = controlWorkModeRun): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) {
        res.status(403).json({ error: 'Local run capability required' }); return;
      }
      const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] || '';
      if (!token || !req.body || Array.isArray(req.body) || typeof req.body.runId !== 'string') {
        res.status(403).json({ error: 'Run capability required' }); return;
      }
      if (Buffer.byteLength(JSON.stringify(req.body)) > 100_000) {
        res.status(413).json({ error: 'Bounded work-mode action required' }); return;
      }
      res.json(await control(req.body.runId, token, req.body));
    } catch (error: any) {
      res.status(error?.code === 'FORBIDDEN' ? 403 : 409).json({ error: error.message || 'Work-mode action failed' });
    }
  };
}

export function createWorkModeRouter(requireAccess: RequestHandler,
  resolveSessionKey: (key: string) => Promise<string | null>) {
  const router = Router();
  router.get('/work-mode-runs', requireAccess, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const profileId = String(req.query.profileId || ''), key = String(req.query.sessionKey || '');
      if (!profileId || !key) { res.status(400).json({ error: 'Profile and session required' }); return; }
      const sessionKey = await resolveSessionKey(key) || key;
      res.json({ runs: await listRationalRuns(profileId, sessionKey) });
    } catch (error: any) { res.status(500).json({ error: error.message }); }
  });
  router.post('/work-mode-runs/:runId/release', requireAccess, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { profileId, sessionKey } = req.body || {};
      if (typeof profileId !== 'string' || typeof sessionKey !== 'string') throw new Error('Profile and session required');
      res.json({ run: await releaseRationalRun(String(req.params.runId), profileId,
        await resolveSessionKey(sessionKey) || sessionKey) });
    } catch (error: any) { res.status(409).json({ error: error.message }); }
  });
  return router;
}
