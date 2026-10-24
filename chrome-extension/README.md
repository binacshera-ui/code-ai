# CODE-AI Personal Chrome

This Manifest V3 extension opens the complete CODE-AI application in Chrome's
Side Panel. After one device-password approval, users can move freely between
profiles and sessions while the extension automatically binds the current
Codex session to the local browser tools.

## Shared background connection (1.5.0)

One authenticated WebSocket per Chrome profile serves all session bindings.
Opening, closing or changing a Side Panel conversation never closes that socket.
Switching conversations no longer automatically reassigns a tab already owned
by another conversation; explicit attach/duplicate still controls ownership.
Delayed session responses cannot overwrite a newer panel conversation.

The worker connects before workspace reconciliation, recreates its recovery
alarm on every activation, sends a 20-second heartbeat, detects stalled socket
and authentication handshakes, and recovers a half-open connection. It does not
replay failed actions or reconnect after explicit device revocation. Connection
diagnostics contain timestamps, classifications and close codes, not secrets,
URLs, command contents or arbitrary provider close-reason text.

Chrome 120 or newer is required. The panel may be closed while browser tools
continue working. If Chrome exits completely, the computer sleeps, networking
is lost or the extension is disabled, the connection cannot stay online; it
recovers when Chrome and networking return. A single extension cannot access
another Chrome profile without a separate installation in that profile.

Use the profile button in the panel to save a name and a small raster avatar.
Chrome's public extension API does not expose the local profile name or avatar;
email/Google-account identity is not presented as a substitute. For an exact
local name and cached Google profile picture on Windows, run the optional
repository helper with an explicitly selected profile directory:

```powershell
.\scripts\export-chrome-profile-identity.ps1 -ProfileDirectory 'Default' -OutputFile "$env:USERPROFILE\Desktop\code-ai-chrome-profile.json"
```

Import that generated JSON using the profile dialog, then save. The helper reads
Local State privately and exports only the selected profile name and optional
cached raster picture. It never modifies Chrome, exports credentials, or infers
the profile from an unrelated account. Built-in Chrome avatars without a cached
picture require manual image selection. The helper is not installed or run
automatically. Full-list device names/avatars require the matching server/UI
update; older servers continue to support the background transport normally.

## Profile editing from every surface (1.5.2)

The Chrome device card identifies the connection as **Chrome extension · personal
computer** and offers a pencil button for editing the name and raster avatar.
This editor is the same on the website, phone and embedded application. Saved
profiles belong to the paired device, not the current conversation.

The matching backend acknowledges a save only after its private device store is
written. It publishes the canonical revision to a connected extension; an offline
extension receives it at its next authenticated connection. A stale reconnect or
delayed device-list response cannot erase a newer acknowledged profile. Concurrent
edits show a conflict and retain the user's edit until an explicit retry.

Extension edits are saved locally first and queued for server synchronization.
The panel distinguishes **saved on this device**, **waiting for synchronization**,
**conflict**, and **saved and synchronized**. Pending edits survive worker reload
and disconnection. An older backend is identified as unsupported rather than
claiming that a local save has synchronized. Deploy the qualified matching
backend/UI before claiming profile editing from all surfaces is active. Profile
names/pictures do not change authorization, session bindings or tab ownership.

## Load the extension

### New computer / reinstallation (1.5.1)

Free access is a policy for an already paired browser, not approval of a new
extension installation. If the app is already open but enrollment says this
installation is not trusted, open **Personal Chrome** in the app, choose
**New extension → Create code**, and enter that one-use code in the extension's
**Connect the new installation** form. The form disappears after pairing.
The existing server pairing endpoint validates the ten-minute code and records
trust for the exact installation. No password or pairing code belongs in chat,
logs, or a support report; the extension never bypasses device authentication.

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `chrome-extension` directory.
4. Click the extension icon to open the Side Panel.
5. Enter the normal CODE-AI device password inside the application once. There
   is no separate pairing screen or session-by-session setup.

## Session tab workspaces

Clicking the extension icon opens the Side Panel only for that Chrome tab. The
panel does not follow the user into unrelated tabs. Open it again from the
extension icon when a different host tab should own the panel.

The toolbar uses one explicit click handler: registering the tab and
requesting its panel happen in the original click, without waiting for an
asynchronous callback that can lose Chrome's user gesture. Every click opens
or keeps that tab's panel open; use the panel's close button to close it. There
is no opening quota and no global manifest panel, so unrelated tabs cannot
inherit it. A previous tab is disabled before its replacement opens, never
afterward; a failed handoff restores the previous tab's availability. Delayed
panel-open events cannot change the owning tab. Failures show a
`!` badge with the error in the icon tooltip instead of silently doing nothing.
After replacing an unpacked installation, click **Reload** in
`chrome://extensions`; replacing files alone does not reload the running worker.

Each active CODE-AI session has a persisted Chrome tab workspace:

- The extension can list and read every scriptable tab in the current Chrome
  profile, so the agent can understand the wider browser context.
- Navigation, clicks, typing, JavaScript, reload, close, and other mutations are
  accepted only for tabs assigned to the current session workspace.
- Existing tabs can be attached explicitly from the **Tabs** drawer or through
  `browser_workspace`. Tabs created or duplicated by the agent are attached
  automatically.
- Assigned tabs are placed in a native Chrome tab group carrying the session
  title and a stable color. A separate group is maintained in every Chrome
  window that contains session tabs.
- Switching CODE-AI sessions changes the active workspace but never silently
  transfers ownership of tabs from one session to another.
- A focus selected in one conversation can be read in another conversation on
  the same server/profile only when its exact ID is explicitly included in the
  new request. This shares a saved, untrusted snapshot for context and permits
  a read-only screenshot while the selected page is unchanged. It does not
  transfer tab ownership or authorize clicks, typing, uploads, or JavaScript.
  If the page has changed, the context remains available but the user must
  select the focus again for a current screenshot.

Chrome profiles are security boundaries. Chrome does not expose tabs from one
profile to an extension process running in another profile. To connect another
profile, load and enroll the extension in that profile as well; CODE-AI will
show it as a separate Chrome device with its own installation id and tabs.

The Side Panel loads CODE-AI through its dedicated `/extension-panel` route.
That route is the only one configured for Chrome-extension framing; normal
CODE-AI pages retain their usual frame protection. The panel waits for a
verified ready message from that route before it posts context or status.

When a packaged extension is updated to a different control origin, it revokes
the old device credential on a best-effort basis, never forwards that credential
to the new origin, and asks for the normal device password once. This also
rebuilds the authenticated browser-tool connection before the application
iframe is opened.

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
  with explicit scopes and a session-specific approval policy.
- The session UI offers smart, strict, and **free-access** policies. New session
  bindings default to free access, which enables every browser capability and
  auto-approves browser operations for that session. An existing explicit smart
  or strict choice is preserved; switching away from free access restores
  approval prompts.
- High-risk actions are surfaced in the Side Panel for human approval unless the
  user explicitly selected free access for that session.
- Sensitive form values are redacted from previews and audit records.
- Port forwards bind only to `127.0.0.1`, expire automatically, and can be
  closed from the session.
- Chrome internal pages and other non-scriptable surfaces remain inaccessible.

The `debugger` and `<all_urls>` permissions are intentionally broad because a
browser operator must be able to inspect arbitrary tabs. Pair only with a
trusted CODE-AI deployment, keep the extension disabled when it is not needed,
and revoke lost devices immediately.
