import { Router } from 'express';
import {
  getSessionFinalNotificationPreference,
  setSessionFinalNotificationPreference,
} from './codexFinalNotifications.js';

const router = Router();

function readIdentity(source: any): { profileId: string | null; sessionKey: string | null } {
  const profileId = typeof source?.profileId === 'string' && source.profileId.trim()
    ? source.profileId.trim()
    : null;
  const sessionKey = typeof source?.sessionKey === 'string' && source.sessionKey.trim()
    ? source.sessionKey.trim()
    : null;
  return { profileId, sessionKey };
}

router.get('/', async (req, res) => {
  try {
    const { profileId, sessionKey } = readIdentity(req.query);
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
    const notification = await setSessionFinalNotificationPreference(
      profileId,
      sessionKey,
      req.body.enabled
    );
    res.json({ notification });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to save final notification preference' });
  }
});

export default router;
