import { Router, type RequestHandler } from 'express';
import * as decisionBoardService from './sessionDecisionBoard.js';
import type { DecisionBoardMutation } from '../shared/decisionBoard.js';

type Service = Pick<typeof decisionBoardService,
  'getSessionDecisionBoard' | 'setSessionDecisionBoard' | 'submitSessionDecisionBoard' | 'rebindSessionDecisionBoard'>;

export interface SessionDecisionBoardRouteDependencies {
  requireAccess: RequestHandler;
  findProfile: (profileId: string) => unknown;
  resolveSessionKey?: (key: string) => Promise<string | null>;
  enqueue: Parameters<typeof decisionBoardService.submitSessionDecisionBoard>[3];
  wrapHandler?: (handler: RequestHandler) => RequestHandler;
}

/** One route implementation for ordinary startup and the qualified additive
 * live adapter. It never imports the queue or starts a second model owner. */
export function createSessionDecisionBoardRouter(
  dependencies: SessionDecisionBoardRouteDependencies,
  service: Service = decisionBoardService,
) {
  const router = Router();
  const wrap = dependencies.wrapHandler || (handler => handler);
  async function scope(value: Record<string, unknown>) {
    const profileId = typeof value.profileId === 'string' ? value.profileId.trim() : '';
    const originalKey = typeof value.sessionKey === 'string' ? value.sessionKey.trim() : '';
    if (!profileId || profileId.length > 180 || !originalKey || originalKey.length > 512) {
      throw Object.assign(new Error('יש לבחור פרופיל ושיחה תקינים.'), { statusCode: 400 });
    }
    if (!dependencies.findProfile(profileId)) {
      throw Object.assign(new Error('הפרופיל שנבחר לא נמצא.'), { statusCode: 404 });
    }
    const sessionKey = await dependencies.resolveSessionKey?.(originalKey) || originalKey;
    if (sessionKey !== originalKey) await service.rebindSessionDecisionBoard(profileId, originalKey, sessionKey);
    return { profileId, sessionKey };
  }
  const handle = (action: RequestHandler) => wrap(async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    try { await action(req, res, next); }
    catch (error: any) {
      if (!res.headersSent) res.status(Number.isInteger(error?.statusCode) ? error.statusCode : 500)
        .json({ error: error?.message || 'לא ניתן לעדכן את לוח ההחלטות כרגע.' });
    }
  });
  router.get('/session-decisions', dependencies.requireAccess, handle(async (req, res) => {
    const { profileId, sessionKey } = await scope(req.query);
    res.json({ board: await service.getSessionDecisionBoard(profileId, sessionKey) });
  }));
  router.put('/session-decisions', dependencies.requireAccess, handle(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw Object.assign(new Error('בקשת השמירה אינה תקינה.'), { statusCode: 400 });
    }
    const { profileId, sessionKey } = await scope(req.body);
    const { expectedRevision, enabled, title, decisionId, answer, answers } = req.body;
    const mutation: DecisionBoardMutation = { expectedRevision,
      ...(enabled !== undefined ? { enabled } : {}), ...(title !== undefined ? { title } : {}),
      ...(decisionId !== undefined ? { decisionId } : {}), ...(answer !== undefined ? { answer } : {}),
      ...(answers !== undefined ? { answers } : {}),
    };
    res.json({ board: await service.setSessionDecisionBoard(profileId, sessionKey, mutation) });
  }));
  router.post('/session-decisions/submit', dependencies.requireAccess, handle(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw Object.assign(new Error('בקשת השליחה אינה תקינה.'), { statusCode: 400 });
    }
    const { profileId, sessionKey } = await scope(req.body);
    res.status(202).json(await service.submitSessionDecisionBoard(profileId, sessionKey, {
      expectedRevision: req.body.expectedRevision, requestId: req.body.requestId,
    }, dependencies.enqueue));
  }));
  return router;
}

export function installSessionDecisionBoardRoutes(
  router: ReturnType<typeof Router>,
  dependencies: SessionDecisionBoardRouteDependencies,
  service: Service = decisionBoardService,
) {
  const child = createSessionDecisionBoardRouter(dependencies, service);
  router.use(child);
  const layer = router.stack.at(-1);
  if (!layer) throw new Error('Decision-board route registration did not complete');
  return { uninstall() { const index = router.stack.indexOf(layer); if (index >= 0) router.stack.splice(index, 1); } };
}
