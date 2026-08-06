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
  return `${String(settings.controlOrigin || configuredOrigin).replace(/\/+$/, '')}/chat?extensionPanel=1`;
}

function openApp() {
  const nextUrl = appUrl();
  if (frame.src !== nextUrl) frame.src = nextUrl;
}

function postToApp(message) {
  if (!frame.contentWindow) return;
  frame.contentWindow.postMessage(message, settings.controlOrigin || configuredOrigin);
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
  openApp();
  const response = await sendRuntimeMessage({ type: 'PANEL_GET_STATE' });
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
  void sendRuntimeMessage({ type: 'PANEL_GET_STATE' })
    .then((response) => {
      setStatus(response);
      postToApp({ type: 'code-ai:extension-request-context' });
    })
    .catch((error) => showNotice(error.message || String(error), 'error'));
});

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== (settings.controlOrigin || configuredOrigin)) return;
  if (event.data?.type === 'code-ai:extension-enrollment') void enrollFromApp(event.data);
  if (event.data?.type === 'code-ai:extension-context') void syncContext(event.data);
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
