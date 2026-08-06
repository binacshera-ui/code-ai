const pairingView = document.querySelector('#pairing');
const connectedView = document.querySelector('#connected');
const frame = document.querySelector('#code-ai-frame');
const connectionDot = document.querySelector('#connection-dot');
const connectionLabel = document.querySelector('#connection-label');
const selectionBanner = document.querySelector('#selection-banner');
const approval = document.querySelector('#approval');
let settings = null;
let currentApproval = null;

function showPairing(error = '') {
  pairingView.hidden = false;
  connectedView.hidden = true;
  document.querySelector('#pair-error').textContent = error;
}

function showConnected(nextSettings) {
  settings = nextSettings;
  pairingView.hidden = true;
  connectedView.hidden = false;
  const origin = String(settings.controlOrigin || 'http://127.0.0.1:4000').replace(/\/+$/, '');
  frame.src = `${origin}/chat?extensionPanel=1`;
}

function setStatus(status) {
  connectionDot.className = `dot ${status.connected ? 'online' : status.paired ? 'offline' : ''}`;
  connectionLabel.textContent = status.connected ? `מחובר · ${status.deviceName || 'Chrome אישי'}` : status.paired ? 'ממתין לחיבור…' : 'לא מחובר';
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
  const response = await chrome.runtime.sendMessage({ type: 'PANEL_GET_STATE' });
  if (!response?.paired) {
    showPairing();
    return;
  }
  showConnected(response.settings);
  setStatus(response);
  renderApproval(response.pendingApproval || null);
}

document.querySelector('#pair-button').addEventListener('click', async () => {
  const button = document.querySelector('#pair-button');
  button.disabled = true;
  document.querySelector('#pair-error').textContent = '';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'PAIR_DEVICE',
      controlOrigin: document.querySelector('#control-origin').value,
      deviceName: document.querySelector('#device-name').value,
      code: document.querySelector('#pairing-code').value,
    });
    if (!response?.ok) throw new Error(response?.error || 'החיבור נכשל');
    showConnected(response.settings);
    setStatus({ paired: true, connected: false, deviceName: response.settings.deviceName });
  } catch (error) {
    document.querySelector('#pair-error').textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#pick-element').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'PANEL_PICK', mode: 'element_picker' });
  selectionBanner.hidden = false;
  selectionBanner.textContent = response?.ok ? `נבחר רכיב: ${response.selection?.name || response.selection?.selector || 'רכיב בדף'}` : response?.error || 'הבחירה בוטלה';
});

document.querySelector('#pick-region').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'PANEL_PICK', mode: 'region_picker' });
  selectionBanner.hidden = false;
  selectionBanner.textContent = response?.ok ? 'האזור נבחר ונשמר לסשן הדפדפן.' : response?.error || 'הבחירה בוטלה';
});

document.querySelector('#open-tab').addEventListener('click', () => {
  if (settings?.controlOrigin) chrome.tabs.create({ url: `${settings.controlOrigin.replace(/\/+$/, '')}/chat` });
});

document.querySelector('#settings').addEventListener('click', async () => {
  if (!confirm('לנתק את התוסף מ־CODE-AI ולבצע pairing מחדש?')) return;
  await chrome.runtime.sendMessage({ type: 'UNPAIR_DEVICE' });
  frame.src = 'about:blank';
  showPairing();
});

document.querySelector('#approve-approval').addEventListener('click', async () => {
  if (!currentApproval) return;
  const response = await chrome.runtime.sendMessage({ type: 'APPROVAL_RESPONSE', approvalId: currentApproval.approvalId, approved: true });
  renderApproval(response?.pendingApproval || null);
});

document.querySelector('#reject-approval').addEventListener('click', async () => {
  if (!currentApproval) return;
  const response = await chrome.runtime.sendMessage({ type: 'APPROVAL_RESPONSE', approvalId: currentApproval.approvalId, approved: false });
  renderApproval(response?.pendingApproval || null);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'BRIDGE_STATUS') setStatus(message.status);
  if (message?.type === 'APPROVAL_REQUEST') renderApproval(message.approval);
  if (message?.type === 'SELECTION_COMPLETE') {
    selectionBanner.hidden = false;
    selectionBanner.textContent = message.selection?.kind === 'region' ? 'האזור נבחר ונשמר.' : `נבחר רכיב: ${message.selection?.name || message.selection?.selector || 'רכיב בדף'}`;
  }
});

void initialize();
