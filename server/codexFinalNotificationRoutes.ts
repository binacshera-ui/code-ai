import { Router } from 'express';
import {
  getSessionFinalNotificationPreference,
  rebindSessionFinalNotificationPreference,
  setSessionFinalNotificationPreference,
} from './codexFinalNotifications.js';

function readIdentity(source: any): { profileId: string | null; sessionKey: string | null } {
  const profileId = typeof source?.profileId === 'string' && source.profileId.trim()
    ? source.profileId.trim()
    : null;
  const sessionKey = typeof source?.sessionKey === 'string' && source.sessionKey.trim()
    ? source.sessionKey.trim()
    : null;
  return { profileId, sessionKey };
}

export function createCodexFinalNotificationRouter(
  resolveSessionKey: (sessionKey: string) => Promise<string | null> = async (sessionKey) => (
    (await import('./codexQueue.js')).resolveCodexQueueSessionId(sessionKey)
  ),
) {
  const router = Router();

  async function canonicalIdentity(source: any) {
    const identity = readIdentity(source);
    if (!identity.profileId || !identity.sessionKey) return identity;
    const canonicalKey = await resolveSessionKey(identity.sessionKey) || identity.sessionKey;
    if (canonicalKey !== identity.sessionKey) {
      await rebindSessionFinalNotificationPreference(identity.profileId, identity.sessionKey, canonicalKey);
    }
    return { profileId: identity.profileId, sessionKey: canonicalKey };
  }

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    try {
      const { profileId, sessionKey } = await canonicalIdentity(req.query);
      if (!profileId || !sessionKey) {
        res.status(400).json({ error: 'Profile id and session key are required' });
        return;
      }
      const notification = await getSessionFinalNotificationPreference(profileId, sessionKey);
      res.json({ notification });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to load final notification preference' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { profileId, sessionKey } = readIdentity(req.body);
      if (!profileId || !sessionKey || typeof req.body?.enabled !== 'boolean') {
        res.status(400).json({ error: 'Profile id, session key and enabled are required' });
        return;
      }
      const canonical = await canonicalIdentity(req.body);
      const notification = await setSessionFinalNotificationPreference(
        profileId,
        canonical.sessionKey!,
        req.body.enabled
      );
      res.json({ notification });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to save final notification preference' });
    }
  });

  return router;
}

export default createCodexFinalNotificationRouter();
