# Native subscription lifecycle

Native Codex app-server subscribes initialized connections to newly created
threads. Long-lived broker recovery and Code AI run connections can therefore
retain unrelated idle subagents after their originating clients leave.

The broker now removes only these incidental subscriptions with
`thread/unsubscribe`. It does not archive, delete, interrupt or directly unload
a thread, terminate MCP processes, change permissions, or enqueue user input.
Native keeps its own inactivity grace period and active-turn checks.

## Preservation rules

- Inspect metadata with `thread/read` and `includeTurns: false`; do not read
  transcripts, tool outputs or credentials for cleanup.
- Protect the complete ancestor tree when any loaded member is active, has a
  queued input, an active goal, a background terminal, or unresolved broker
  custody. System-error, unknown and ephemeral states remain protected.
- Retain subscriptions explicitly requested through `thread/start`,
  `thread/resume` or `thread/fork`, including descendants. Leave desktop, IDE
  and other non-Code AI frontend subscriptions unchanged.
- Serialize unsubscription with broker admission and completion. Retain
  resources while a public resume is in flight. Missing inspection support,
  invalid pagination, unavailable metadata or an unknown acknowledgement
  prevents cleanup instead of affecting the turn outcome.
- Reattach the still-loaded protected tree to recovery after a broker-only
  handoff. Resuming a root alone does not subscribe a replacement connection to
  existing children. These resumes carry no setting overrides or input.
  Threads with active/unknown goals or pending inputs are excluded because a
  native resume can continue an active goal. A thread already unloaded is skipped.

Cleanup runs after startup and terminal/thread-created events, with a
five-minute fallback interval. It does not expose a maintenance mutation RPC.
Releasing a subscription does not promise immediate resource reclamation; the
installed native version decides when an idle unsubscribed thread expires.

## Verification

```sh
npm run test:codex-subscriptions
```

The handoff integration test requires an explicit existing runner module:

```sh
CODE_AI_LIFECYCLE_FIXTURE_RUNNER=/absolute/path/to/profile-runner.mjs \
  node --test server/codexSharedSubscriptions.handoff.test.mjs
```

It starts a separate synthetic protocol owner in a private temporary home,
creates pending parent/child questions, replaces only that fixture's adapter,
and proves identical native PID/start identity, engine/lock inodes, zero input
submissions, question reconnection, preservation of an active tree including
idle children, and expiry of unrelated orphan subscriptions. Its accelerated
expiry is a fixture behavior, not a claim about native's production timer.

The installed binary can independently qualify recovery and permission
preservation against a loopback fake provider without real account data:

```sh
node scripts/codex-native-submit-contract.mjs /absolute/path/to/codex \
  --broker --disconnect --restart-broker --interrupt-own --recover-interrupted
node scripts/codex-native-subscription-contract.mjs /absolute/path/to/codex
```

The second native fixture exercises the cleanup implementation against native
metadata, goal, queue, terminal and unsubscription APIs, verifies
`unsubscribed`/`notSubscribed` responses, unchanged stored history and thread ID,
the initial grace period, and an explicit follow-up on the intended thread.
It does not claim to have observed the entire thirty-minute expiry.

## Manual broker-only handoff

This source change does not restart a service. An operator must first prepare
a concrete handoff and rollback using the installed runner's existing
`adoptRecordedNative` contract. Ordinary service restart and SIGTERM/SIGHUP to
the runner also stop native; they are unsuitable for preserving active jobs.

Before replacement:

1. Fetch main, review relevant open PRs, and compare the candidate with both
   main and the broker path actually recorded in the active profile and
   `ownership.json`. MCP launch arguments may point at an older release than
   the active broker. Preserve accepted permission and recovery fixes.
2. Preserve the profile, custody record, reservation journal, effective unit
   configuration and previous broker dependency closure in the HDD backup.
   Record broker/runner/native hashes, native PID/start identity, engine and
   lock inodes, and metadata-only active thread/turn IDs.
3. Recheck the same live source and identities immediately before switching.
   Keep active native and application workers running. Do not replace the
   application release, manipulate histories or create a second native owner.
4. Use the existing one-use broker-handoff ticket and runner adoption path,
   changing only the adapter under an explicitly scoped systemd policy that
   preserves the native process. Restore normal process-manager policy once
   readiness and custody are proved. The new broker requires its complete
   import closure, including `codexSharedSubscriptions.mjs`.
5. Confirm the exact native generation and engine/lock inodes are unchanged,
   unresolved reservations retain their IDs and settings, and clients rejoin
   their existing turns without submitting new inputs. Repeat a harmless
   read-only tool call in the active conversation. Observe metadata-only
   resource and loaded-thread counts beyond native's actual grace period.

Rollback must use the same adapter adoption contract and preserved predecessor
broker closure, retaining the same native process. Do not fall back to a fresh
owner, ordinary service restart, archive/unarchive or killing MCP children.
Any ambiguous custody, failed active-client recovery, changed live source or
unproven rollback blocks the live handoff. A passing isolated fixture is not
evidence that production has been changed or resource reclamation completed.
