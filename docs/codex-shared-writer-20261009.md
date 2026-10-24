# Codex native writer ownership — diagnosis and unactivated transport work

Status: **not fixed in production; no production service, desktop app, credential,
thread lock, or conversation has been stopped or replaced by this work.**

## Confirmed cause

The original writer-lock diagnosis used central CLI 0.162.0; the central CLI
subsequently advanced to 0.162.1 through its existing updater (not this work).
Ubuntu's desktop application bundles
0.162.0-alpha.2 at `/usr/lib/chatgpt/resources/codex`. Both reject a second
independent process resuming an already-loaded thread, even without a model turn.
Ubuntu's durable Code AI queue contains two matching failures on October 8.

The exact 0.162.0 native source implements `WriterLockCoordinator` over
`CODEX_HOME/thread-writer-locks`. Its guard is retained by the loaded local thread,
not just while a turn runs. This is distinct from Code AI's per-conversation queue
serialization. An idle native GUI can therefore retain a writer indefinitely.

Source: [0.162.0 writer lock implementation](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/rollout/src/writer_lock.rs).
Deleting or replacing a held lock's inode is not a safe solution: it permits two
independent writers without reconciling their in-memory histories.

## Proven narrow alternative

One native app-server owner accepts multiple local clients over a private Unix
socket. Two clients can resume the same synthetic thread ID, disconnect, and
reconnect without a writer conflict. No real conversation or credentials were
read in this proof. The final proof requests only initialize/thread-resume, never
turn-start or queue-add. Queue-add must not be assumed free of automatic model work.

The transport is WebSocket over a Unix socket, not raw JSONL. Native
`app-server proxy` passes raw HTTP Upgrade/frame bytes and is not a JSONL adapter.
See [official App Server protocol](https://learn.chatgpt.com/docs/app-server).

`scripts/codex-shared-stdio.mjs` implements a disposable JSONL client adapter. It
checks same-UID private socket-directory ownership and the initialized owner's
canonical CODEX_HOME, bounds frame/buffer memory, sequences asynchronous handshake
validation, and emits only fixed diagnostics. EOF/signals close this client only.
It never launches a daemon, falls back to another writer, or deletes lock files.

The current source uses native `thread/turn/queue/add` rather than a check-idle
then `turn/start` race. It persists a stable client-message ID before submission,
correlates only its own root/child turns, and reconciles transport loss without
replaying the prompt. Cancellation requires native proof. Root and child question
recovery rebinds only an unanswered, proven detached request, preserving its UI
ID. Recovery tombstones suppress requests already resolved by the native owner;
uncertain native custody cannot be purged or replayed under the same message ID.
The source integration is explicitly opt-in and remains OFF in production;
default isolated behavior is unchanged.

## Why this is not a production fix yet

1. Ubuntu's existing GUI and IDE use private stdio app-server processes. The
   inspected native app supports `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` on its
   ordinary local-host launch, using the canonical private control socket. That
   is a next-launch mechanism, not an in-place transfer of an existing writer.
   Actual GUI/IDE migration has not been exercised; no app was stopped.
2. Installed Code AI runtimes still invoke `codex exec --json`, rather than the
   pending source app-server runner. This transport-only artifact does not replace
   that execution path or enable itself through an environment switch.
3. Browser/Chrome/phone/design modes prepare configuration overlays. Their home,
   MCP identity and per-thread config must be reconciled with a single canonical
   owner without leaking one conversation's settings or credentials to another.
4. Native atomic queue arbitration, stable ownership, disconnect recovery and
   own-turn cancellation now have isolated evidence. However, queue/add does not
   atomically pin per-message settings. A real native settings-race fixture
   proves GUI model updates can alter already queued Code AI work. A preflight
   settings comparison is not a fix for that race or a full MCP-mode contract.
5. Main had four running jobs, one queued and one scheduled at the observed
   boundary; its singleton queue must not be restarted to install this work.
   BEAM/Ubuntu queues were idle, which does not establish native GUI idleness.
6. The Windows reverse SSH listener refused connections. No Windows native
   transport or desktop startup migration was tested; the current adapter fails
   explicitly on Windows.
7. Completion notifications racing a recovery history snapshot still need an
   ordering contract. Answer-delivery persistence across process replacement,
   distinct retry attempt identities and recurrence also remain unqualified.
   The new fail-closed custody guards do not imply those lifecycles are complete.

## Required next steps and acceptance

- Establish one same-user, private owner per canonical profile; migrate every GUI,
  IDE and Code AI client, not just the web UI. Preserve auth and all conversation
  IDs. Do not fork conversations to hide writer conflicts.
- Prove inter-client queued input survives active work, and cancellation targets
  only the submitting client's own turn. Do not interrupt desktop work to acquire
  a thread, or reuse the process-local question registry across unrelated turns.
- Complete mode-specific configuration and subagent/request routing contracts.
- Capture the execution-path change onto each currently installed, verified
  release variant, preserving the existing draft blocker and Ubuntu history fixes.
  Build through BEAM, verify the exact import, and activate only at an atomic safe
  queue boundary. Existing loaded desktop writers need a coordinated close/relaunch
  after their work finishes; do not kill them on an unproved idle observation.
- Accept only after real native GUI + Code AI clients can submit to the same thread
  while an idle GUI remains open, see each other's persisted history, survive a
  client disconnect, preserve active tasks/questions, and operate after startup.

## Reproducible evidence

- `node scripts/codex-writer-contract.mjs ABSOLUTE_CODEX_BIN`: two isolated writers
  conflict, synthetic history only.
- `node scripts/codex-shared-writer-contract.mjs ABSOLUTE_CODEX_BIN [BUNDLED_ADAPTER]`:
  one Unix-socket owner, two clients and reconnection, synthetic history only.
- `node --test scripts/codex-shared-stdio.test.mjs`: adapter transport/security tests.
- `ops/shared-codex-owner/capture.mjs`: explicitly reviewed immutable qualification
  capture on HDD, submitted via the approved BEAM `node-package-v1` profile.

This evidence demonstrates an architectural path, not that all servers are fixed.

## October 10 verification and deployment boundary

Main's canonical native owner passed eight synthetic checks on 0.162.1; Ubuntu's
bundled 0.162.0-alpha.2 passed the same eight. The settings-race fixture passed ten
checks demonstrating the missing configuration-pinning contract. All use marked
synthetic homes and a loopback fake provider, with no real inference or account.

The current source also adds leased deployment admission and a durable bounded
systemd/flock coordinator. Its tests do not establish a safe first upgrade of
installed legacy runtimes: already-aborted async HTTP work is not retrospectively
counted, and the passive upload ingress must participate in the same gate.
The future source protocol aggregates wrapped route ingress over a private UDS,
including route callback completion after socket abort and active inventory
after owner reconnection. That is not a whole-application ingress proof:
top-level proxy/session middleware, store callbacks and external writes can
outlive local request/peer lifetime. A mandatory static unqualified participant
now refuses full-app seal; there is no environment override. Its tests do not
upgrade installed legacy handler tracking or qualify replacement continuity.
No automatic deployment watcher is installed. See
[the cumulative boundary audit](../ops/deferred-deployment/baseline-audit.md).
