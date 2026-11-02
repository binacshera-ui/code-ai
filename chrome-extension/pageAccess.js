const failure = (code, message) => Object.assign(new Error(message), { code });

export function assertAutomationPage(tab) {
  if (!tab?.id || !tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    throw failure('UNSUPPORTED_PAGE', 'Chrome internal pages cannot be automated by extensions.');
  }
  let hostname;
  try { hostname = new URL(tab.url).hostname.toLowerCase().replace(/\.+$/, ''); }
  catch { throw failure('UNSUPPORTED_PAGE', 'The target page has no supported URL.'); }
  if (hostname === 'chrome.google.com' || hostname === 'chromewebstore.google.com') {
    throw failure('CHROME_STORE_RESTRICTED', 'Chrome blocks extension scripting and debugger access to the Chrome Web Store domain. Use a supported native browser interface for this page.');
  }
}

// Chrome's attach failure is not necessarily another debugger. Return stable,
// useful classifications without reflecting a target URL or arbitrary text.
export function debuggerAttachFailure(cause) {
  const message = String(cause?.message || cause || '');
  if (/extensions gallery cannot be scripted|chrome web store|webstore.*restrict/i.test(message)) {
    return failure('CHROME_STORE_RESTRICTED', 'Chrome blocks extension scripting and debugger access to the Chrome Web Store domain.');
  }
  if (/another debugger.*attached|already attached/i.test(message)) {
    return failure('DEBUGGER_BUSY', 'Another debugger is attached to this tab. Detach that debugger before using debugger tools here.');
  }
  if (/\bpolicy\b|\badministrator\b|\benterprise\b/i.test(message)) {
    return failure('DEBUGGER_POLICY_BLOCKED', 'Chrome policy blocks debugger access. Check the effective browser policies.');
  }
  return failure('DEBUGGER_ATTACH_FAILED', 'Chrome could not attach the debugger to this target. Check the target restrictions and browser diagnostics.');
}
