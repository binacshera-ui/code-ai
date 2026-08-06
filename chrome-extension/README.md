# CODE-AI Personal Chrome

This Manifest V3 extension opens CODE-AI in Chrome's Side Panel and connects
explicitly paired browser tabs to a Codex session through the Personal Chrome
mode. It is designed for real-browser inspection and interaction while keeping
the session, device, scopes, approvals, and audit trail visible to the operator.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `chrome-extension` directory.
4. Click the extension icon to open the Side Panel.
5. Enter the CODE-AI control-plane origin and a one-time pairing code created
   in **Modes → Personal Chrome**.

Use `npm run extension:package -- --output <directory> --control-origin
<origin>` to create a deployable copy with a pre-filled origin. Do not edit a
deployed copy as the source of truth.

## Security model

- Pairing codes are short-lived and single-use.
- Device credentials are generated after pairing and stored in Chrome local
  extension storage.
- Each Codex session receives a separate, revocable binding with explicit
  read/write scopes and an approval policy.
- High-risk actions are surfaced in the Side Panel for human approval.
- Sensitive form values are redacted from previews and audit records.
- Port forwards bind only to `127.0.0.1`, expire automatically, and can be
  closed from the session.
- Chrome internal pages and other non-scriptable surfaces remain inaccessible.

The `debugger` and `<all_urls>` permissions are intentionally broad because a
browser operator must be able to inspect arbitrary tabs. Pair only with a
trusted CODE-AI deployment, keep the extension disabled when it is not needed,
and revoke lost devices immediately.
