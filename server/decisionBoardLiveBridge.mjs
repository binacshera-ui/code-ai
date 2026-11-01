// Additive compatibility slice for the already-running singleton. This module
// imports neither the queue nor a provider runtime: all ownership, authorization
// and lifecycle tracking come from that existing process.
const INSTALLATION = Symbol.for('code-ai.session-decision-board.live.v1');

function hasDecisionRoutes(router, visited = new Set()) {
  if (visited.has(router)) return false;
  visited.add(router);
  return router.stack.some(layer => ['/session-decisions', '/session-decisions/submit'].includes(layer.route?.path)
    || (Array.isArray(layer.handle?.stack) && hasDecisionRoutes(layer.handle, visited)));
}

export function installDecisionBoardLiveBridge(scope, domain) {
  if (!scope?.router || !Array.isArray(scope.router.stack)) throw new TypeError('Existing owner router is required');
  if (scope.router[INSTALLATION]) return scope.router[INSTALLATION];
  for (const name of ['requireAccess', 'findProfile', 'resolveSessionKey', 'enqueue', 'wrapHandler',
    'getFlowPromptBuilder', 'setFlowPromptBuilder', 'getFlowIngest', 'setFlowIngest', 'getFlowRebind', 'setFlowRebind']) {
    if (typeof scope[name] !== 'function') throw new TypeError(`Missing owner decision-board scope: ${name}`);
  }
  for (const name of ['installSessionDecisionBoardRoutes', 'buildSessionDecisionBoardPromptAdditions',
    'ingestSessionDecisionBoardFromText', 'rebindSessionDecisionBoard']) {
    if (typeof domain?.[name] !== 'function') throw new TypeError(`Missing decision-board domain function: ${name}`);
  }
  const originalPrompt = scope.getFlowPromptBuilder();
  const originalIngest = scope.getFlowIngest();
  const originalRebind = scope.getFlowRebind();
  if (![originalPrompt, originalIngest, originalRebind].every(value => typeof value === 'function')) {
    throw new TypeError('Existing Flow hook bindings are required');
  }
  // Existing routes mean either an ordinary successor is already running or
  // an earlier unrecorded operation must be reconciled, never layered twice.
  if (hasDecisionRoutes(scope.router)) {
    throw new Error('Decision-board routes already exist; reconcile the existing installation');
  }
  const reportFailure = (operation, error) => {
    const failure = { operation, statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 500 };
    // Never log decision text, session identifiers, prompts or provider data.
    try {
      if (typeof scope.reportDecisionFailure === 'function') scope.reportDecisionFailure(failure);
      else console.warn('[decision-board] Optional decision update failed; original turn outcome preserved', failure);
    } catch { /* Optional diagnostics cannot turn a successful native turn into failure. */ }
  };
  const prompt = async function decisionBoardPrompt(...args) {
    const prior = await originalPrompt.apply(this, args);
    const addition = await domain.buildSessionDecisionBoardPromptAdditions(args[0], args[1]);
    if (!addition) return prior;
    return prior ? `${prior}\n\n${addition}` : addition;
  };
  const ingest = async function decisionBoardIngest(...args) {
    // Preserve the fourth Flow map-revision target and its exact return type.
    // Decision ingestion uses only the canonical profile/session/text tuple.
    const prior = await originalIngest.apply(this, args);
    try { await domain.ingestSessionDecisionBoardFromText(args[0], args[1], args[2]); }
    catch (error) { reportFailure('ingest', error); }
    return prior;
  };
  const rebind = async function decisionBoardRebind(...args) {
    const prior = await originalRebind.apply(this, args);
    try { await domain.rebindSessionDecisionBoard(args[0], args[1], args[2]); }
    catch (error) { reportFailure('rebind', error); }
    return prior;
  };
  // Install the very same canonical handlers as the ordinary successor. The
  // supplied enqueue closure remains the live owner's current durable writer.
  const routes = domain.installSessionDecisionBoardRoutes(scope.router, {
    requireAccess: scope.requireAccess, findProfile: scope.findProfile,
    resolveSessionKey: scope.resolveSessionKey, enqueue: (...args) => scope.enqueue(...args),
    wrapHandler: scope.wrapHandler,
  }, domain);
  if (typeof routes?.uninstall !== 'function') throw new TypeError('Canonical decision-board routes must return an uninstall handle');
  const removeRoutes = () => routes.uninstall();
  try {
    scope.setFlowPromptBuilder(prompt);
    scope.setFlowIngest(ingest);
    scope.setFlowRebind(rebind);
  } catch (error) {
    if (scope.getFlowPromptBuilder() === prompt) scope.setFlowPromptBuilder(originalPrompt);
    if (scope.getFlowIngest() === ingest) scope.setFlowIngest(originalIngest);
    if (scope.getFlowRebind() === rebind) scope.setFlowRebind(originalRebind);
    removeRoutes();
    throw error;
  }
  const installation = {
    installed: true, version: 1, additive: true, queueWriterImported: false,
    nativeOwnerChanged: false, asyncTracking: true,
    uninstall() {
      if (!installation.installed) return;
      removeRoutes();
      if (scope.getFlowPromptBuilder() === prompt) scope.setFlowPromptBuilder(originalPrompt);
      if (scope.getFlowIngest() === ingest) scope.setFlowIngest(originalIngest);
      if (scope.getFlowRebind() === rebind) scope.setFlowRebind(originalRebind);
      if (scope.router[INSTALLATION] === installation) delete scope.router[INSTALLATION];
      installation.installed = false;
    },
  };
  Object.defineProperty(scope.router, INSTALLATION, { value: installation, configurable: true });
  return installation;
}
