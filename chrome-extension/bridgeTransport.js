// One profile-wide channel. Panel and conversation lifetimes never own it.
// Messages are never replayed: retrying a timed-out click/submit could duplicate it.
export function createBridgeTransport({ getUrl, getAuth, onMessage, onStatus,
  WebSocketClass = WebSocket, now = Date.now,
  // WorkerGlobalScope methods are brand-checked by Chrome. Calling copied
  // methods as timers.setTimeout() changes their receiver and throws an
  // "Illegal invocation" in Chrome, even though Node's timers accept it.
  timers = {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
  },
}) {
  let socket = null;
  let enabled = false;
  let authenticated = false;
  let retry = null;
  let deadline = null;
  let keepalive = null;
  let attempt = 0;
  let lastReceived = 0;
  const events = [];
  function record(kind, extra = {}) {
    events.push({ at: new Date(now()).toISOString(), kind, ...extra });
    if (events.length > 30) events.shift();
  }
  function clearConnectionTimers() {
    timers.clearTimeout(deadline); deadline = null;
    timers.clearInterval(keepalive); keepalive = null;
  }
  function publish() { onStatus(authenticated); }
  function schedule() {
    if (!enabled || retry) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, attempt++));
    retry = timers.setTimeout(() => { retry = null; connect(); }, delay);
  }
  function retire(kind, code = 1000) {
    const previous = socket;
    socket = null;
    authenticated = false;
    clearConnectionTimers();
    record(kind);
    publish();
    // Fence old callbacks before close(); a stale socket must not retire its successor.
    if (previous?.readyState < WebSocketClass.CLOSING) {
      try { previous.close(code, kind); } catch { /* already fenced; recover normally */ }
    }
    schedule();
  }
  function connect() {
    if (!enabled || socket) return;
    try { socket = new WebSocketClass(getUrl()); }
    catch { record('connect_error'); schedule(); return; }
    const current = socket;
    record('connecting');
    deadline = timers.setTimeout(() => {
      if (socket === current) retire('connect_timeout');
    }, 15_000);
    current.addEventListener('open', () => {
      if (socket !== current) return;
      timers.clearTimeout(deadline);
      record('socket_open');
      deadline = timers.setTimeout(() => {
        if (socket === current && !authenticated) retire('auth_timeout');
      }, 10_000);
      try { current.send(JSON.stringify(getAuth())); }
      catch { retire('auth_send_error'); }
    });
    current.addEventListener('message', event => {
      if (socket !== current) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      lastReceived = now();
      if (message.type === 'auth_ok') {
        timers.clearTimeout(deadline); deadline = null;
        if (!authenticated) {
          authenticated = true; attempt = 0;
          record('authenticated'); publish();
          // Chrome 116+: exchanging messages within 30 seconds keeps the worker alive.
          keepalive = timers.setInterval(() => wake(), 20_000);
        }
      }
      onMessage(message);
    });
    current.addEventListener('close', event => {
      if (socket !== current) return;
      socket = null; authenticated = false; clearConnectionTimers();
      // Only metadata, never the provider's free-text close reason.
      record('socket_closed', { code: event.code, clean: event.wasClean === true });
      if (event.code === 4004) enabled = false; // Revocation is not a reconnect loop.
      publish(); schedule();
    });
    current.addEventListener('error', () => {
      if (socket === current) retire('socket_error');
    });
  }
  function send(message) {
    if (!authenticated || socket?.readyState !== WebSocketClass.OPEN) {
      const error = new Error('Personal Chrome bridge is offline.');
      error.code = 'DEVICE_OFFLINE'; throw error;
    }
    try { socket.send(JSON.stringify(message)); }
    catch (error) { retire('send_error'); throw error; }
  }
  function wake() {
    if (!enabled) return;
    if (!socket) { timers.clearTimeout(retry); retry = null; connect(); return; }
    if (!authenticated) return; // Connect/auth deadlines recover stalled handshakes.
    if (now() - lastReceived > 65_000) { retire('heartbeat_timeout'); return; }
    try { send({ type: 'event', version: 1, name: 'heartbeat', payload: { at: new Date(now()).toISOString() } }); }
    catch { /* send() schedules recovery */ }
  }
  return {
    start() { enabled = true; connect(); },
    stop(kind = 'disconnected') {
      enabled = false; timers.clearTimeout(retry); retry = null; attempt = 0;
      retire(kind);
    },
    wake, send,
    snapshot() { return { connected: authenticated, reconnectAttempt: attempt,
      lastReceivedAt: lastReceived ? new Date(lastReceived).toISOString() : null,
      events: events.map(event => ({ ...event })) }; },
  };
}
