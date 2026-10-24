// Issue both requests, in order, during the actual click. Chrome applies
// setOptions synchronously in the browser process, but delivers its response
// asynchronously. Waiting for that response loses the user gesture needed by
// open(). Observe both results only after the opening request has been issued.
export function openTabPanel(chromeApi, tab) {
  if (!Number.isInteger(tab?.id) || tab.id < 0) {
    return Promise.reject(new Error('No Chrome tab is available for the CODE-AI panel.'));
  }
  let registration;
  try {
    registration = chromeApi.sidePanel.setOptions({ tabId: tab.id, path: 'panel.html', enabled: true });
    const opening = chromeApi.sidePanel.open({ tabId: tab.id });
    return Promise.all([registration, opening]).then(() => undefined);
  } catch (error) {
    // A synchronous open failure must not leave a rejected registration
    // promise unobserved. Do not retry after the gesture or open globally.
    if (registration) void Promise.resolve(registration).catch(() => undefined);
    return Promise.reject(error);
  }
}
