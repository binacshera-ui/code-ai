# CODE-AI Personal Chrome

This Manifest V3 extension opens the complete CODE-AI application in Chrome's
Side Panel. After one device-password approval, users can move freely between
profiles and sessions while the extension automatically binds the current
Codex session to the local browser tools.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `chrome-extension` directory.
4. Click the extension icon to open the Side Panel.
5. Enter the normal CODE-AI device password inside the application once. There
   is no separate pairing screen or session-by-session setup.

When a packaged extension is updated to a different control origin, it revokes
the old device credential on a best-effort basis, never forwards that credential
to the new origin, and asks for the normal device password once. This also
rebuilds the frame-header rules before the application iframe is opened.

Use `npm run extension:package -- --output <directory> --control-origin
<origin>` to create a deployable copy with a pre-filled origin. Do not edit a
deployed copy as the source of truth.

## Security model

- The normal device password is handled only by CODE-AI and is never exposed to
  or stored by the extension.
- CODE-AI returns a short-lived, single-use enrollment token after successful
  device-password verification.
- Device credentials are generated after pairing and stored in Chrome local
  extension storage.
- Each active Codex session receives a separate, revocable binding automatically,
  with explicit scopes and a risk-based approval policy.
- High-risk actions are surfaced in the Side Panel for human approval.
- Sensitive form values are redacted from previews and audit records.
- Port forwards bind only to `127.0.0.1`, expire automatically, and can be
  closed from the session.
- Chrome internal pages and other non-scriptable surfaces remain inaccessible.

The `debugger` and `<all_urls>` permissions are intentionally broad because a
browser operator must be able to inspect arbitrary tabs. Pair only with a
trusted CODE-AI deployment, keep the extension disabled when it is not needed,
and revoke lost devices immediately.
