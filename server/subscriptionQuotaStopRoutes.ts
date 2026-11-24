import { Router, type RequestHandler } from 'express';
import { CODEX_APP_CONFIG } from './config.js';
import { readSubscriptionQuotaStop, updateSubscriptionQuotaStop } from './subscriptionQuotaStop.js';
import { validateSubscriptionQuotaStopSettings } from '../shared/subscriptionQuotaStop.js';

export function createSubscriptionQuotaStopRouter(requireAccess: RequestHandler, dependencies = {
  profiles: CODEX_APP_CONFIG.profiles,
  read: readSubscriptionQuotaStop,
  update: updateSubscriptionQuotaStop,
}) {
  const router = Router();
  router.use('/subscription-quota-stop', requireAccess, (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    next();
  });
  const profile = (id: unknown) => typeof id === 'string' && id.trim()
    ? dependencies.profiles.find(p => p.id === id.trim())
    : dependencies.profiles.find(p => p.defaultProfile) || dependencies.profiles[0];
  router.get('/subscription-quota-stop', async (req, res) => {
    const selected = profile(req.query.profile);
    if (!selected) { res.status(404).json({ error: 'הפרופיל לא נמצא.' }); return; }
    try { res.json({ quotaStop: await dependencies.read(selected) }); }
    catch { res.status(503).json({ error: 'לא ניתן לקרוא את הגבלת מכסת המנוי כרגע.' }); }
  });
  router.put('/subscription-quota-stop', async (req, res) => {
    const selected = profile(req.body?.profileId);
    if (!selected) { res.status(404).json({ error: 'הפרופיל לא נמצא.' }); return; }
    let settings;
    try { settings = validateSubscriptionQuotaStopSettings(req.body); }
    catch { res.status(400).json({ error: 'סף המכסה אינו תקין. יש לבחור ניצול בין 0.1% ל־100%.' }); return; }
    try { res.json({ quotaStop: await dependencies.update(selected, settings, {
      ...(typeof req.body?.accountScope === 'string' ? { expectedAccountScope: req.body.accountScope } : {}),
    }) }); }
    catch (error: any) {
      const status = [400, 409].includes(error?.statusCode) ? error.statusCode : 503;
      res.status(status).json({ error: status !== 503 ? error.message : 'לא ניתן לשמור את הגבלת מכסת המנוי כרגע.' });
    }
  });
  return router;
}
