// Compatibility bridge for the existing owner process. All authoritative state,
// durable persistence and authorization remain in that process's lexical scope.
// The injected selection helpers are built from the same release source as the
// ordinary routes; never import the queue module and create a second writer.
const INSTALLATION = Symbol.for('code-ai.owner-queue-http.v1');

function finalGetHandler(router, routePath) {
  const matches = router.stack.filter(layer => layer.route?.path === routePath && layer.route.methods?.get);
  if (matches.length > 1) throw new Error(`Multiple owner GET routes found for ${routePath}`);
  if (!matches.length) return null;
  const layer = matches[0].route.stack.filter(entry => typeof entry.handle === 'function').at(-1);
  if (!layer) throw new Error(`Owner GET route has no handler: ${routePath}`);
  return layer;
}

export function installOwnerQueueHttp(scope, helpers) {
  const { router } = scope || {};
  if (!router || !Array.isArray(router.stack) || typeof router.get !== 'function') {
    throw new TypeError('Owner queue router is required');
  }
  if (router[INSTALLATION]) return router[INSTALLATION];
  for (const name of ['getState', 'ensureStateLoaded', 'normalizeSessionBindingKey',
    'resolveSessionBindingFromState', 'sortQueueItems', 'toCodexQueueListItem',
    'requireCodexAccess', 'persist', 'getEnqueue', 'setEnqueue']) {
    if (typeof scope[name] !== 'function') throw new TypeError(`Owner queue scope.${name} is required`);
  }
  for (const name of ['selectQueueWorkspaceView', 'selectQueueHistoryPage']) {
    if (typeof helpers?.[name] !== 'function') throw new TypeError(`Owner queue helper ${name} is required`);
  }
  const queueLayer = finalGetHandler(router, '/queue/items');
  if (!queueLayer) throw new Error('Existing owner GET /queue/items was not found');
  const existingHistoryLayer = finalGetHandler(router, '/queue/history');
  const legacyQueueHandler = queueLayer.handle;
  const legacyHistoryHandler = existingHistoryLayer?.handle;
  const originalEnqueue = scope.getEnqueue();
  if (typeof originalEnqueue !== 'function') throw new TypeError('Owner enqueue function is required');
  const wrapHandler = typeof scope.wrapHandler === 'function' ? scope.wrapHandler : handler => handler;

  function readWorkspace(req) {
    const profileId = typeof req.query.profile === 'string' ? req.query.profile : undefined;
    const key = scope.normalizeSessionBindingKey(typeof req.query.queueKey === 'string' ? req.query.queueKey.trim() : '');
    const resolvedSessionId = key ? scope.resolveSessionBindingFromState(key, { fallbackToSelf: true }) : null;
    const state = scope.getState();
    if (!state || !Array.isArray(state.items)) throw new Error('Owner queue state is not ready');
    return {
      key, resolvedSessionId,
      items: profileId ? state.items.filter(item => item.profileId === profileId) : state.items,
      boundSessionId: key && resolvedSessionId && key !== resolvedSessionId ? resolvedSessionId : null,
    };
  }
  const compact = wrapHandler(async function compactOwnerQueue(req, res) {
    try {
      await scope.ensureStateLoaded();
      const { key, resolvedSessionId, items, boundSessionId } = readWorkspace(req);
      const view = helpers.selectQueueWorkspaceView(items, key, resolvedSessionId);
      const relatedKeys = new Set([key, resolvedSessionId].filter(Boolean));
      res.json({
        items: scope.sortQueueItems(view.items).map(item => scope.toCodexQueueListItem(item,
          (relatedKeys.has(item.queueKey) || relatedKeys.has(item.sessionId))
          && ['draft', 'failed', 'cancelled'].includes(item.status))),
        boundSessionId,
        history: view.history,
      });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.status(500).json({ error: error?.message || 'Failed to load Codex queue' });
    }
  });
  const dispatch = function ownerQueueView(req, res, next) {
    // Preserve the old protocol and its tracked handler verbatim. Existing
    // clients can keep loading the full failed/cancelled history on demand.
    return req.query.view === 'compact' ? compact(req, res, next) : legacyQueueHandler(req, res, next);
  };
  const history = wrapHandler(async function ownerQueueHistory(req, res) {
    try {
      await scope.ensureStateLoaded();
      const { key, resolvedSessionId, items } = readWorkspace(req);
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const page = helpers.selectQueueHistoryPage(items, { queueKey: key, resolvedSessionId, cursor, limit });
      res.json({ ...page, items: page.items.map(item => scope.toCodexQueueListItem(item, false)) });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.status(/Invalid queue history cursor/.test(error?.message || '') ? 400 : 500)
        .json({ error: error?.message || 'Failed to load Codex queue history' });
    }
  });
  const enqueue = async function ownerDurableEnqueue(...args) {
    const accepted = await originalEnqueue.apply(this, args);
    // Old dedupe returned an in-memory row before the first request's commit.
    // Every successful result now crosses the existing owner's durable barrier.
    await scope.persist();
    return accepted;
  };

  let installedHistoryLayer;
  queueLayer.handle = dispatch;
  if (existingHistoryLayer) existingHistoryLayer.handle = history;
  else {
    router.get('/queue/history', scope.requireCodexAccess, history);
    installedHistoryLayer = router.stack.at(-1);
  }
  scope.setEnqueue(enqueue);
  const receipt = {
    installed: true,
    compactOnly: true,
    historyRoute: true,
    enqueueDurabilityBarrier: true,
    asyncTracking: typeof scope.wrapHandler === 'function',
    uninstall() {
      if (queueLayer.handle === dispatch) queueLayer.handle = legacyQueueHandler;
      if (existingHistoryLayer?.handle === history) existingHistoryLayer.handle = legacyHistoryHandler;
      if (installedHistoryLayer) {
        const index = router.stack.indexOf(installedHistoryLayer);
        if (index >= 0) router.stack.splice(index, 1);
      }
      if (scope.getEnqueue() === enqueue) scope.setEnqueue(originalEnqueue);
      if (router[INSTALLATION] === receipt) delete router[INSTALLATION];
      receipt.installed = false;
    },
  };
  Object.defineProperty(router, INSTALLATION, { value: receipt, configurable: true });
  return receipt;
}
