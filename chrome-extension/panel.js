const configuredOrigin = new URL(
  document.querySelector('meta[name="code-ai-control-origin"]')?.content || 'http://127.0.0.1:4000',
).origin;
const frame = document.querySelector('#code-ai-frame');
const connectionDot = document.querySelector('#connection-dot');
const connectionLabel = document.querySelector('#connection-label');
const selectionBanner = document.querySelector('#selection-banner');
const approval = document.querySelector('#approval');
let settings = { controlOrigin: configuredOrigin };
let currentApproval = null;
let enrollmentInFlight = false;
let lastContextKey = '';
let frameReady = false;
let pendingAppMessages = [];

async function sendRuntimeMessage(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response) throw new Error('שירות הרקע של התוסף לא החזיר תשובה. טען מחדש את התוסף ונסה שוב.');
    return response;
  } catch (error) {
    throw new Error(error?.message || String(error));
  }
}

function showNotice(text, tone = 'info') {
  selectionBanner.hidden = !text;
  selectionBanner.dataset.tone = tone;
  selectionBanner.textContent = text || '';
}

function appUrl() {
  return `${String(settings.controlOrigin || configuredOrigin).replace(/\/+$/, '')}/extension-panel`;
}

function openApp() {
  const nextUrl = appUrl();
  if (frame.src !== nextUrl) {
    frameReady = false;
    frame.src = nextUrl;
  }
}

function queueAppMessage(message) {
  const messageType = typeof message?.type === 'string' ? message.type : null;
  if (messageType) {
    const existingIndex = pendingAppMessages.findIndex((item) => item?.type === messageType);
    if (existingIndex >= 0) pendingAppMessages.splice(existingIndex, 1);
  }
  pendingAppMessages.push(message);
  if (pendingAppMessages.length > 16) pendingAppMessages.shift();
}

function sendToReadyApp(message) {
  if (!frame.contentWindow) return false;
  frame.contentWindow.postMessage(message, settings.controlOrigin || configuredOrigin);
  return true;
}

function flushPendingAppMessages() {
  if (!frameReady || pendingAppMessages.length === 0) return;
  const messages = pendingAppMessages;
  pendingAppMessages = [];
  try {
    for (const message of messages) sendToReadyApp(message);
  } catch {
    frameReady = false;
    pendingAppMessages = [...messages, ...pendingAppMessages].slice(-16);
  }
}

function postToApp(message) {
  if (!frameReady) {
    queueAppMessage(message);
    return;
  }
  try {
    sendToReadyApp(message);
  } catch {
    // During a full navigation the iframe briefly points at an extension-owned
    // about:blank document. Wait for the next signed ready message instead of
    // leaking a console error or sending to the wrong document.
    frameReady = false;
    queueAppMessage(message);
  }
}

function setStatus(status) {
  settings = { ...settings, ...(status.settings || {}), controlOrigin: status.controlOrigin || status.settings?.controlOrigin || settings.controlOrigin || configuredOrigin };
  connectionDot.className = `dot ${status.connected ? 'online' : status.paired ? 'offline' : ''}`;
  connectionLabel.textContent = status.connected
    ? `כלי דפדפן מחוברים · ${status.deviceName || settings.deviceName || 'Chrome אישי'}`
    : status.paired
      ? 'CODE-AI פתוח · כלי הדפדפן מתחברים…'
      : 'CODE-AI פתוח · נדרש אישור מכשיר חד־פעמי';
  postToApp({ type: 'code-ai:extension-status', ...status });
}

function renderApproval(nextApproval) {
  currentApproval = nextApproval || null;
  approval.hidden = !currentApproval;
  if (!currentApproval) return;
  document.querySelector('#approval-title').textContent = currentApproval.title || 'נדרש אישור';
  document.querySelector('#approval-description').textContent = currentApproval.description || '';
  document.querySelector('#approval-preview').textContent = currentApproval.argumentsPreview || '';
}

async function initialize() {
  const configured = await sendRuntimeMessage({ type: 'PANEL_CONFIGURE_ORIGIN', controlOrigin: configuredOrigin });
  if (!configured.ok) throw new Error(configured.error || 'לא ניתן להגדיר את כתובת CODE-AI.');
  settings = configured.settings || settings;
  setStatus(configured);
  openApp();
  const response = await sendRuntimeMessage({ type: 'PANEL_GET_STATE' });
  if (response.ok === false) throw new Error(response.error || 'לא ניתן לקרוא את מצב התוסף.');
  settings = response.settings || settings;
  setStatus(response);
  renderApproval(response.pendingApproval || null);
}

async function enrollFromApp(message) {
  if (enrollmentInFlight || !message.enrollmentToken) return;
  enrollmentInFlight = true;
  showNotice('מאשר את המכשיר ומחבר את כלי הדפדפן…');
  try {
    const response = await sendRuntimeMessage({
      type: 'ENROLL_DEVICE',
      controlOrigin: configuredOrigin,
      deviceName: 'Chrome במחשב האישי',
      enrollmentToken: message.enrollmentToken,
    });
    if (!response.ok) throw new Error(response.error || 'אישור המכשיר נכשל.');
    settings = response.settings || settings;
    setStatus({ ...response, paired: true });
    showNotice('המכשיר אושר. CODE-AI וכלי הדפדפן מוכנים.', 'success');
    frameReady = false;
    frame.src = appUrl();
  } catch (error) {
    showNotice(error.message || String(error), 'error');
  } finally {
    enrollmentInFlight = false;
  }
}

async function syncContext(context) {
  if (!context?.authenticated || !context?.deviceUnlocked || context.provider !== 'codex') return;
  const contextKey = `${context.serverId || 'local'}:${context.profileId || ''}:${context.sessionKey || ''}`;
  if (!context.profileId || !context.sessionKey || contextKey === lastContextKey) return;
  lastContextKey = contextKey;
  try {
    const response = await sendRuntimeMessage({ type: 'SYNC_ACTIVE_SESSION', context });
    if (!response.ok) throw new Error(response.error || 'חיבור כלי הדפדפן לסשן נכשל.');
    if (response.personalChromeMode) {
      postToApp({
        type: 'code-ai:extension-mode-synced',
        serverId: response.serverId,
        profileId: response.profileId,
        sessionKey: response.sessionKey,
        personalChromeMode: response.personalChromeMode,
      });
    }
  } catch (error) {
    lastContextKey = '';
    showNotice(error.message || String(error), 'error');
  }
}

document.querySelector('#pick-element').addEventListener('click', async () => {
  try {
    const response = await sendRuntimeMessage({ type: 'PANEL_PICK', mode: 'element_picker' });
    showNotice(response?.ok ? `נבחר רכיב: ${response.selection?.name || response.selection?.selector || 'רכיב בדף'}` : response?.error || 'הבחירה בוטלה', response?.ok ? 'success' : 'error');
  } catch (error) {
    showNotice(error.message || String(error), 'error');
  }
});

document.querySelector('#pick-region').addEventListener('click', async () => {
  try {
    const response = await sendRuntimeMessage({ type: 'PANEL_PICK', mode: 'region_picker' });
    showNotice(response?.ok ? 'האזור נבחר ונשמר לסשן הדפדפן.' : response?.error || 'הבחירה בוטלה', response?.ok ? 'success' : 'error');
  } catch (error) {
    showNotice(error.message || String(error), 'error');
  }
});

document.querySelector('#open-tab').addEventListener('click', () => {
  void chrome.tabs.create({ url: `${String(settings.controlOrigin || configuredOrigin).replace(/\/+$/, '')}/chat` });
});

document.querySelector('#settings').addEventListener('click', async () => {
  if (!confirm('לאפס את אישור המכשיר? CODE-AI יישאר פתוח ותידרש שוב סיסמת המכשיר פעם אחת.')) return;
  try {
    await sendRuntimeMessage({ type: 'UNPAIR_DEVICE' });
    lastContextKey = '';
    setStatus({ paired: false, connected: false, settings });
    showNotice('אישור המכשיר אופס. הזן שוב את הסיסמה בתוך CODE-AI.', 'info');
    frameReady = false;
    frame.src = appUrl();
  } catch (error) {
    showNotice(error.message || String(error), 'error');
  }
});

document.querySelector('#approve-approval').addEventListener('click', async () => {
  if (!currentApproval) return;
  const response = await sendRuntimeMessage({ type: 'APPROVAL_RESPONSE', approvalId: currentApproval.approvalId, approved: true });
  renderApproval(response?.pendingApproval || null);
});

document.querySelector('#reject-approval').addEventListener('click', async () => {
  if (!currentApproval) return;
  const response = await sendRuntimeMessage({ type: 'APPROVAL_RESPONSE', approvalId: currentApproval.approvalId, approved: false });
  renderApproval(response?.pendingApproval || null);
});

frame.addEventListener('load', () => {
  // The iframe must identify itself from the configured CODE-AI origin before
  // the panel can post messages. openApp()/pagehide reset frameReady around
  // real navigations; do not reset it here because React may send ready before
  // the document's final load event fires.
  void sendRuntimeMessage({ type: 'PANEL_GET_STATE' })
    .then((response) => {
      setStatus(response);
    })
    .catch((error) => showNotice(error.message || String(error), 'error'));
});

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== (settings.controlOrigin || configuredOrigin)) return;
  const message = event.data || {};
  if (message.type === 'code-ai:extension-unloading') {
    frameReady = false;
    return;
  }
  if (message.type === 'code-ai:extension-ready' || message.type === 'code-ai:extension-context' || message.type === 'code-ai:extension-enrollment') {
    frameReady = true;
    flushPendingAppMessages();
  }
  if (message.type === 'code-ai:extension-ready') {
    postToApp({ type: 'code-ai:extension-request-context' });
    return;
  }
  if (message.type === 'code-ai:extension-enrollment') void enrollFromApp(message);
  if (message.type === 'code-ai:extension-context') void syncContext(message);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'BRIDGE_STATUS') setStatus(message.status);
  if (message?.type === 'APPROVAL_REQUEST') renderApproval(message.approval);
  if (message?.type === 'SELECTION_COMPLETE') {
    showNotice(message.selection?.kind === 'region' ? 'האזור נבחר ונשמר.' : `נבחר רכיב: ${message.selection?.name || message.selection?.selector || 'רכיב בדף'}`, 'success');
  }
});

void initialize().catch((error) => {
  openApp();
  showNotice(error.message || String(error), 'error');
});
