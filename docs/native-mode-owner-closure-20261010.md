# Native shared owner: mode closure

Scope: investigation and an additive source implementation of the Code AI
execution-mode contract while native GUI and Code AI use one canonical
Codex app-server owner. No installed owner, real credentials,
conversation, native database, system service, GUI, or thread lock was changed
by this investigation.

## Actual isolated evidence

`scripts/codex-shared-mode-contract.mjs` runs one native Unix-socket owner, two
clients, two synthetic threads, a synthetic stdio MCP, and a loopback fake
Responses provider. It sanitizes inherited credential-related environment
variables, uses a fresh private home, and terminates only its own fixture.

| Exact native program | Result | Fake requests | Real provider requests |
| --- | --- | --- | --- |
| BEAM `/usr/local/bin/codex`, `codex-cli 0.162.1` | 7 checks passed | 6 | 0 |
| Ubuntu `/usr/lib/chatgpt/resources/codex`, `codex-cli 0.162.0-alpha.2` | 7 checks passed | 6 | 0 |

The same fixture's `--dispatcher-root <absolute codex-shared-modes directory>`
option additionally exercises the real new MCP frontend and private Unix
transport. Both exact binaries passed **11 checks**, with 10 fake-provider
requests and zero real-provider requests. They prove native metadata routing
through the actual frontend, separate thread targets, backend replacement at
the same socket path while native stays live, disabled-record denial and
unknown-child/missing-metadata denial. The original seven-check variant remains
the proof of per-thread environment isolation and ignored loaded-resume config;
the dispatcher variant does not claim to re-prove those environment overrides.

`node --test server/codex-shared-modes/transport.test.mjs`: **18 checks passed**,
all disposable. This includes concurrent two-thread routing, absent/malformed
native metadata, model identity spoofing, source-profile custody persistence,
explicit mode denial, exact post-run relocation, private ownership/permissions,
unproven/live/mismatched socket preservation, verified dead-owner recovery,
idempotent graceful draining, payload bounds, offline catalog serving and
reconnection, image blocks, and five credential-free original tool catalogs.

The actual native MCP `tools/call` request contains `_meta.threadId` equal to
the originating synthetic thread. Model-supplied `claimedThreadId` disagreed
and was not used for routing. Different `thread/start` MCP environment
overrides remained isolated between threads A and B. A second client could
resume loaded A with different MCP configuration, but A's MCP environment
remained unchanged: the override was **ignored**, not applied.

This establishes the native transport/routing boundary. It does not establish
live Code AI mode bridges, GUI migration, production rollout, native children,
or end-to-end mode availability. The upstream source inspected separately was
commit `8e6a44b`; its `with_mcp_tool_call_ids_meta` adds native thread/item IDs.
Do not confuse that source revision with either tested installed binary.

Official reference: [Codex App Server: start/resume](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread).
Its documented configuration overrides do not by themselves prove that
overrides replace an already-loaded subscribed thread. The installed-native
fixture establishes the narrower observed behavior above.

## Existing code retained

`runCodexPrompt` currently chains design -> UX -> browser -> personal Chrome ->
phone preparation and launches with the last prepared overlay `CODEX_HOME`.
All five preparations preserve the existing mode-specific runtimes, private
bindings, permissions, audit paths and session keys.

| Mode | Preparation source | Existing dispatch boundary |
| --- | --- | --- |
| Personal Chrome | `server/codexPersonalChromeMode.ts` | `server/personalChromeBridge.ts`: private binding, tool validation, scope checks, workspace and approval controls |
| Hosted browser | `server/codexBrowserMode.ts` | `server/codexBrowserViewer.ts`: leased per-session runtime and MCP calls |
| Phone | `server/codexPhoneMode.ts` | `dispatchPhoneTool`, active mode/version checks, archive and confirmation policy |
| Design | `server/codexDesignMode.ts` | `dispatchDesignConsultation`, active registration, fixed workspace and consultation budget |
| UX | `server/codexUxMode.ts` | `dispatchUxConsultation`, active registration, fixed workspace and existing limits |

The implementation adds narrow private entries into the Phone, Design, UX and
hosted-browser validation/dispatch paths, not another
phone/browser/Gemini engine or a bypass of their access rules.
Personal Chrome deliberately retains its original private-record-controlled
HTTP tool-call route. A remote agent's browser record can refer to a main-server
binding; its token and workspace do not live in the agent's local bridge map.
Calling the retained route preserves the main bridge's argument/scopes,
approval, revocation, browser selection and workspace validators.

## Why removing the current refusal alone is wrong

1. Each overlay is a real per-session directory. It symlinks existing entries
   from the prior home, excluding `config.toml` and, for some modes, `skills`.
   If `thread-writer-locks` exists when prepared, the overlay shares its existing
   native lock root. It is not an independent safe transcript owner. If an entry
   does not exist yet it is not symlinked, so depending on enumeration to provide
   a lock boundary is also not a reliable contract.
2. The shared stdio bridge verifies the initialized owner's canonical home
   against `realpath(CODEX_HOME)`. Using an overlay root with a canonical owner
   therefore fails identity validation. Shared transport must always use the
   canonical profile home, never the prepared overlay home.
3. Loaded subscribed threads ignore resume `config` overrides even when idle.
   Passing the overlay's MCP entries to `thread/resume` does not enable modes in
   a GUI-owned thread. A native `mcpServer/refresh` is global to loaded threads;
   writing one conversation's token into canonical config and refreshing is not
   safe per-session routing.
4. Queue/add has no per-message MCP or execution-settings override. A preflight
   model/effort comparison does not pin an accepted queued message. The parent
   implementation must explicitly preserve the shared native owner-settings
   contract rather than silently claim isolated per-message settings.

## Minimal implementable full path

Retain the canonical native owner and its queue. Install a small per-profile
mode MCP dispatcher under the **same existing server names** (`personal_chrome`,
`browser_mode`, `phone_mode`, `design_mode`, `ux_mode`). Its configuration contains
only a trusted profile binding and private local bridge path, not per-session
tokens, phone API keys, account credentials, browser bindings or mutable mode
environment. Do not alter global account/auth settings.

The MCP frontends can serve their existing static schemas for `initialize` and
`tools/list` without requiring a live Code AI connection. This permits native
Codex to remain useful when Code AI is stopped. `tools/call` must fail truthfully
if the private bridge is unavailable; it must not fall back to another session
or public endpoint. Optional MCP initialization avoids making a stopped Code AI
service prevent unrelated native GUI work.

Typed boundary:

```ts
type NativeModeCall = {
  nativeThreadId: string; // from native params._meta.threadId, never args
  nativeItemId?: string;
  server: 'personal_chrome' | 'browser_mode' | 'phone_mode' | 'design_mode' | 'ux_mode';
  toolName: string;
  arguments: Record<string, unknown>;
};
```

Profile identity is fixed by the private dispatcher/socket installation, not
selected by model arguments. Use a per-profile private directory/socket owned
by the native UID; validate ownership and permissions. Code AI resolves
`profile + nativeThreadId` to the exact active mode record and existing private
registration. It rechecks enabled state and registration revision on every call
and invokes the existing dispatcher. No token is returned to the MCP/model.

Keep namespaces and existing schemas unchanged. Advertising static mode tools
is not permission to use them: disabled/unbound calls return a structured
`MODE_DISABLED`/`MODE_UNAVAILABLE`. Never route by current tab, cwd resemblance,
most recent session, global last device, or a model-supplied session/profile ID.
This preserves native tool-name compatibility and actual browser authorization.

For child/fork threads, resolve only a proven native session tree to the root
mode binding. An unknown child must be denied; do not guess from matching cwd.
The native `_meta.threadId` fixture proves root routing only. Child/root
association and revoke propagation require a separate representative test.

Integration changes:

1. Keep mode preparations/runtime leases before dispatch so existing records and
   bridges are ready; separate bridge preparation from legacy overlay selection.
2. In the shared branch use canonical `buildCodexProcessEnv(profile)` and the
   canonical socket, while retaining the existing mode preparation artifacts
   for isolated execution. Do not initialize the bridge with an overlay home.
3. Register mode context against the actual native thread before queue/add.
   For a new thread bind its exact originally prepared mode state profile/key;
   do **not** move the mode record or revoke a registration before queue/add.
   This preserves the existing private-run lifecycle, browser lease and Chrome
   provisional workspace/selection. The ordinary queue performs its existing
   source-key -> native-key rebind only after the run finishes.
4. Reuse existing backend validators and state checks through narrowly exported
   adapters. For Chrome keep binding revocation, tools/scopes, workspace,
   background behavior, port TTL, uploads and approval handling unchanged. For
   other modes retain the corresponding policies, budget and workspace rules.
5. Use a stable private local bridge path across Code AI replacement. Resolve
   current registrations server-side per call so a long-lived native owner
   cannot retain old process-local bearer tokens after Code AI restarts.
6. Desktop and Code AI must both use the installed canonical owner. Installing
   this dispatcher on one owner does not unlock an already-running independent
   stdio GUI or IDE owner. Migration remains the parent's live rollout gate.
7. Mode prompt additions/skills remain meaningful. Shared owner cannot discover
   skills solely through an overlay it does not use; expose the existing skill
   paths through canonical supported discovery or explicit bounded context.
   Do not say `$gemini-design-partner`/`$reapre-phone-control` is installed if the
   canonical owner cannot discover it. Do not copy account/auth files to solve it.

## Required qualification before removing the mode refusal

- Two threads with distinct private bindings concurrently call the same mode
  server and hit only their own existing registration.
- Model arguments containing false profile/thread/session IDs cannot switch the
  resolved target; missing/malformed native metadata is rejected.
- Disabled and revoked mode records cannot call an old registration, including
  native children and a mode-toggle while input is queued.
- Browser runtime leasing survives a shared queue wait and normal client
  disconnect; cancellation/replacement releases only this run's lease.
- Code AI restart while a canonical owner remains live reconnects to current
  mode bindings without exposing stale tokens or accepting another profile.
- Correct server names/tool schemas/images are preserved; wrong namespaces and
  tools are rejected; resources, timeout and result-content semantics match
  the retained mode MCP scripts (images are not downgraded to JSON text).
- Desktop/Code AI see one native thread and one writer, with existing history,
  questions, drafts and queued work retained.
- Exact native binaries on each host pass the root/child and mode bridge
  contracts; Windows is a separate unsupported/offline transport gate.

No configuration swap, feature activation, auth rotation, GUI stop, restart,
deployment or native database mutation was performed by this mode investigation.

## Implemented source API and lifecycle

`server/codexSharedModes.ts` exports:

- `ensureCodexSharedModeBridge(profile, { uid, gid })`: stable private endpoint,
  exact existing namespace configurations and public catalog hashes. Use the
  **actual authorized native-owner UID/GID**, not unconditional home ownership.
  Main's explicit root execution policy can differ from home-directory ownership.
  Only the new private bridge directory/files are aligned; no profile tree chown.
- `bindCodexSharedModeContext(nativeProfileId, nativeThreadId, bindings)`: private
  custody IDs only. Each mode maps to `{ profileId, sessionKey }` or explicit
  `null` denial. Source state profile is trusted preparation/queue context,
  never model input. The only default is an exact same-profile/same-native-thread
  mode record; there is no cwd, nearest session, device or descendant fallback.
- `getCodexSharedModeAvailability(profileId, nativeThreadId)`: enabled booleans
  only, respecting explicit custody mappings.
- `refreshCodexSharedModeContextAfterRebind(nativeProfileId, nativeThreadId,
  server, stateProfileId, previousSessionKey)`: call only after the existing queue
  proves its post-run state rebind. It requires the exact old metadata mapping,
  missing old record and present actual record; it cannot change the profile or
  another thread. Chrome's original browser binding/token/workspace are not
  rebound. Because Design/UX rebind revokes registrations and Phone changes its
  revision, their ordinary preparations must run against the actual key before
  immediate native-GUI mode calls can succeed. Without preparation, they
  truthfully return `MODE_UNAVAILABLE`, not an old registration.
- `closeCodexSharedModeBridges()`: idempotent draining. Stop new accepts, discard
  idle incomplete requests, let accepted operations finish, then remove exact
  owned endpoint custody. Call before shutting the existing mode/provider
  backends. The deploy/shutdown controller must choose a timeout that matches
  accepted tool duration; this helper cannot prevent an external forced kill.

New runtime modules under `server/codex-shared-modes/`: `mcp.mjs`, `transport.mjs`,
`results.mjs`, `contexts.mjs`, **`endpoint.mjs`**. All five must be packaged beside
the frontend. Five retained frontends have an additive pure `--describe-tools`
entry which runs before credentials/runtime initialization; browser export
requires only standard Python, not installed browser packages.

`mode-contexts.json` contains only native thread IDs and exact mode custody IDs,
is owner-only, validates its fixed shape, and is serialized/atomically replaced.
No provider token, URL, call arguments, result, user history or credentials are
written into that routing file or the canonical MCP configuration.

`modes.sock.custody.json` contains only socket identity and process-incarnation
metadata. Recovery requires a private same-UID marker, exact socket inode/device,
the proven dead owner PID/start-time/boot identity, and a refused loopback Unix
connection. A live, foreign, symlinked, unmarked or mismatched endpoint is never
removed. No process is killed to free an endpoint. Recovery tests terminate only
their own marked synthetic child and leave installed owners untouched.

Production integration and rollout belong to the parent task. The evidence
above does not prove live provider calls, concurrent real browser state, GUI
owner migration, per-message native settings, Windows transport, or child-mode
inheritance. Those remain explicit parent qualification gates.
