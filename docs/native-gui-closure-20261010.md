# Native GUI launch closure — isolated evidence and reversible migration

## Delivered boundary

Use the existing supported `CODEX_CLI_PATH` launch override, not an ASAR patch
and not lock-file deletion. `scripts/codex-shared-cli.mjs` delegates CLI version
and schema probes to the exact original native binary. Its `app-server` stdio
invocation becomes a JSONL client of the qualified same-user shared owner.
It never starts another app-server, kills an owner, or falls back to one.

The dispatcher accepts only stdio, the native analytics flag, and these three
observed GUI boolean requirements:

- `features.code_mode_host`
- `plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled`
- `plugins.code-review@openai-bundled.mcp_servers.code-review.enabled`

It privately compares those fields with `config/read` after verifying the native
owner's initialized `codexHome`. Unknown flags and mismatches produce a fixed
diagnostic; config bodies and inputs are not printed.

## Why the stock opt-in flag did not work

Installed Ubuntu program `application-network-startup-Bt0a8E1L.js` requires an
empty `getConfigOverrides` result before selecting its local daemon transport.
The ordinary connection built in `main-B6ZOwXa3.js` always includes both bundled
plugin enabled overrides. Therefore setting only
`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` cannot switch this installed ordinary GUI
connection to a common owner.

The parent GUI did not have `CODEX_CLI_PATH`; its child native process receives
that variable from the ordinary GUI transport. Clearing the child's variable is
not a next-launch solution. The live GUI's three boolean requirements were
compared privately with the synthetic owner startup contract and retained.

## Actual native proof, not a full desktop migration claim

`scripts/codex-native-launch-contract.mjs` extracted ten required original
installed CommonJS program chunks into an owned temporary directory. It used
the original GUI transport class, bundled native `0.162.0-alpha.2`, the dispatcher
and JSONL adapter, with a synthetic canonical home and one private native Unix
owner. No inference, user conversations or credentials were used.

Ten checks passed on Ubuntu:

- installed original transport code loaded;
- fixture process succeeded;
- original GUI class used the shared client;
- owner profile matched;
- synthetic thread identity matched;
- GUI remained connected while a second Code AI client resumed that same thread;
- second client's profile matched;
- second client could read after GUI disconnect;
- native owner survived that disconnect;
- no model turn was requested.

Installed transport SHA256:
`aa5478e31c8a623632dfedffcecfbe40d5033d38a8504649716657681a0840b4`.

This is an actual installed transport-class integration test, not a claim that
the live desktop instance has migrated. Electron's `ELECTRON_RUN_AS_NODE` path
was not usable in this build and is not used by the fixture.

Pure dispatcher tests: 10 passed. Reversible artifact tests: 7 passed. Owner
runner pure lifecycle tests: 18 passed. Combined local: 35 passed, 0 failed,
one actual-native test skipped locally and qualified on both hosts below. The dispatcher
identifies the actual subcommand after global option values; prompt/file text
spelled `app-server` reaches the original CLI unchanged. Unsupported launch
requirements before a real app-server command are refused, not silently dropped.
A separate
isolated native probe verified that an explicit private backend listener does
not occupy/create the canonical frontend endpoint.

## Actual native alias custody and restart recovery

The first production preparation exposed a native backend contract missed by
the original direct-socket fixture: native creates `engine.sock` as a same-user
alias to its private `codex-daemon-UID` target. The runner now records exact
alias, target and target-parent inode metadata, plus the actual spawned native
process executable, process generation, cgroup hash and network namespace.
Custody requires that exact process to hold the listening kernel socket FD;
a thin launcher or surviving foreign daemon is not adopted.

An accepted stream connection may have the same `/proc/net/unix` pathname as
its listener. The proof now selects the SO_ACCEPTCON listening stream, while
recovery's target-gone check remains conservative over every kernel entry.
A deterministic regression holds an accepted connection during readiness.

The exact BEAM `0.162.1` and Ubuntu bundled `0.162.0-alpha.2` each passed all
19 runner tests. Their actual-native case used a disposable home and synthetic
broker: startup, initialized home equality, normal stop/restart, then SIGKILL of
only the owned fixture process group and another restart. The hidden target was
never unlinked by the runner; native may remove its own target on a normal stop.
Recorded dangling aliases recover, new native process generations are verified,
and the persistent lock inode plus original canonical endpoint remain unchanged.
Foreign aliases, changed target inodes, live targets behind missing aliases and
unproven old custody fail closed. No model turn or installed change was made.

Frozen source hashes, final counts, qualification scope and resolved fixture
failures are recorded in
`ops/native-owner/native-runner-lifecycle-qualification-20261010.json`.

## Public deployment identity inventory

`ops/native-owner/native-program-inventory-20261010.json` records the exact real
native ELF/Node paths, program SHA256s, versions, runtime UID/GID/user/group and
six canonical profile homes across main, BEAM, PCI and Ubuntu. It was collected
read-only and independently parsed against the deployment plan fields. Main's
explicit root runtime policy is retained independently of profile directory
ownership; PCI runs as `admin` UID/GID 1001, not the SSH login `binapay-admin`.

Main and BEAM use native `0.162.1`. PCI uses `0.160.1`; this census proves its
installed program identity and version only. A distinct public `0.162.1` ELF
copy was qualified as PCI UID/GID 1001 in an owned private temporary workspace:
nine startup/baseline checks, the actual shared-writer resume/disconnect contract,
and eleven actual MCP dispatcher checks passed. The installed legacy vendor
binary remains unchanged. The `qualifiedCandidate` field records its real path,
SHA256 and version for the root controller's later immutable installation.
No installed GUI archive was present for a PCI GUI fixture, so none is claimed.
Ubuntu uses the exact bundled `0.162.0-alpha.2` covered by the ten-check installed
transport fixture. Its original desktop Exec is `chatgpt %U`: preserve the field
code in a desktop entry, but pass only actual URL arguments to a direct relaunch.
Existing main daemons and Ubuntu's independent helper owners are explicitly
preserved. Process metadata alone does not prove whether the live GUI is in an
active turn; this remains unknown until a live transport/status check establishes
it. No installed service, desktop or program changes were made by the census.

`scripts/codex-native-baseline-contract.mjs` also privately verified all nine
startup checks on main `0.162.1` and Ubuntu `0.162.0-alpha.2`: both preserved
feature toggles, file-backed MCP credential store choice and all three GUI
booleans are reflected by the actual native `config/read` result. Only equality
metadata was emitted. Receipts are in
`ops/native-owner/native-baseline-contract-20261010.json`; no inference or live
account/history was used. Initial temporary-fixture path/dependency-transfer
failures were corrected and the exact failing probes rerun successfully.

## Profile artifacts and API

`ops/native-owner/profile-artifacts.mjs` validates a public per-profile plan and
renders, without installing, a user systemd unit and per-user desktop override.
The original `/usr/share/applications/chatgpt.desktop`, `/usr/bin/chatgpt`, native
binary and application archive remain unchanged.

`ops/native-owner/profile-runner.mjs` pins the explicit native and broker program
hashes; retains `HOME`, `CODEX_HOME`, original CLI path and all three GUI startup
booleans, existing `remote_compaction_v2` and `default_mode_request_user_input`
feature toggles, and existing file-backed MCP OAuth store choice; starts the native
engine on `ownerDirectory/engine.sock`; then imports
the qualified broker and calls:

```js
startCodexSharedOwnerBroker({
  socketPath: plan.frontendSocket,
  backendSocket,
  codexHome: plan.codexHome,
  journalPath: `${plan.ownerDirectory}/broker-journal.json`,
})
```

The selected frontend is the dedicated product owner at
`CODEX_HOME/code-ai-shared-owner/owner.sock`. This deliberately preserves existing
native canonical daemon endpoints and daemons, including ones with a different
spawn UID. The dispatcher gets this explicit frontend from its launch plan.
Legacy canonical-path support is retained only for an explicitly proven plan;
no native endpoint is stolen. It checks native profile identity before marking
readiness. Owner/frontend directories are same-UID 0700 and listeners are
Unix-only. The optional `mcpDispatchers` array contains at most five additive
public configurations for `personal_chrome`, `browser_mode`, `phone_mode`,
`design_mode`, and `ux_mode`, including `required: false` and bounded startup/tool
timeouts. Per-thread credentials
remain in the existing private mode-binding mechanism. Native stderr is drained
without copying account/config context into journald.

`ops/native-owner/gui-launcher.mjs` launches the unchanged original desktop
executable with its original arguments, the same user profile, and the dispatcher
override. This is a next-launch change. It neither closes nor migrates an already
running GUI. The dispatcher module must be executable; the launcher prepends the
qualified Node directory to PATH for its shebang. Both adapter modules and their
`ws` dependency must be present in the qualified artifact.

## Exact installation and rollback boundary

1. Qualify the complete accepted application plus broker/MCP/dispatcher/runner
   artifact. Preserve the current accepted release and authentication baseline.
2. Inventory native owners for the exact profile. An already-loaded private
   writer must release ownership normally; do not signal unrelated helper owners
   or user jobs based on appearance alone.
3. Preserve the current per-user desktop override, if any, and the exact original
   unit/plan paths before installing new per-user artifacts. Do not overwrite the
   system desktop entry or user's Codex config/account files.
4. The runner takes a persistent OS `flock` on `owner.lock`; it never deletes or
   recreates that lock inode. `ownership.json` privately records the exact socket
   device/inode/UID, profile/home/program pins, runner/native PIDs and boot ID.
   Restart recovery can remove only the identical recorded product socket inodes
   after the prior owner is dead (or its boot ended) and refusal probes prove no
   listener remains. Changed/unrecorded/symlink/live endpoints fail closed. A
   different qualified successor can start when old endpoints are already absent;
   stale sockets with changed program pins require a predecessor-qualified
   controller step. Early startup death before frontend custody was recorded
   remains an explicit recovery gate. No legitimate native endpoint or writer
   lock is deleted by this mechanism.
5. Start the scoped owner unit under the runtime's explicit spawn UID; verify
   profile identity and Unix-only
   sockets; install/launch the per-user desktop override after its prior owners
   released loaded threads. Native bundled plugin tools use dynamic per-thread
   GUI setup, including `CODEX_APP_TOOLS_PIPE_PATH`; do not preserve an obsolete
   pipe by copying a live environment globally.
6. Verify actual GUI plus Code AI submission/history/disconnection/cancellation
   on the same conversation, and perform independent host readback.

Rollback restores the saved per-user desktop override and application flag,
then retires only this explicit profile owner after its own accepted work is
handled. Original accounts, signing, conversations, source profile and binaries
are untouched. A prior independent GUI writer must not be relaunched concurrently
with work still owned by the shared owner.

No installed launcher, owner unit, live GUI, private writer, SSH connection policy
or authentication was changed by this stream. Windows and full live desktop
migration remain untested here.

## Later live Ubuntu readback — 2026-10-10 22:07 UTC

The preceding no-installed-effects statements describe the earlier qualification
and census phases. The root deployment controller subsequently installed the
qualified shared owner and normally closed/relaunched the scoped Ubuntu GUI.
This stream's subsequent audit was read-only: it did not install, restart, kill,
alter credentials or request a model turn. It did not stop unrelated native
writers or remove writer-lock inodes.

The root's independently rerun live readback completed at
`2026-10-10T22:07:20.685Z`, with unchanged application build
`b6196953-8f40-4acb-a040-1b31a912bea6` and runner controller
`aff5bbc8-e0a0-4d34-8bd1-a04f42a95036`. Its sanitized receipt is:

`/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/native-unlock-b6196953-8f40-4acb-a040-1b31a912bea6/gui-migration-readback-receipt.json`

Receipt mode: `0600`. SHA256:
`6effaf15a8fe76fd3ab6d7dd0606fa9286280ef1c92a05e4f19b10113753c66c`.

### Authoritative GUI attachment evidence

The observed process chain was GUI `494435` (`/usr/lib/chatgpt/ChatGPT`) ->
managed dispatcher `494622` -> stdio adapter `494636`, all under UID 1000 and
the same GUI cgroup. Native owner `494200` remained in the separate owned
service cgroup. Artifact/native hashes, process generations, profile home,
managed child environment equality and native listener custody all passed.
There were zero standalone GUI-descendant native app-server processes.

The Electron parent `/proc/494435/environ` contained 1122 bytes, all zero.
Therefore absence of `CODEX_CLI_PATH` there was a false-negative acceptance
gate, not evidence that the launch override was unused. Both actual managed
children carried the exact plan's managed launch fields; only equality metadata
was returned. No raw environment was printed and the component responsible for
zeroing the parent environment was not inferred.

The stronger proof followed actual kernel peers: the dispatcher's inherited
stdin/stdout/stderr sockets had ESTAB peers held by the GUI, and the adapter
held an ESTAB peer of the product broker. The latter paired broker inode
`1672367` with adapter inode `1673290`. Listener custody independently matched
the native process's exact listening FD, executable, start generation, cgroup
and network namespace. Thus the real GUI uses the managed shared-owner route;
parent-environment presence is not the authority for this decision.

### Existing GPU history and installed GUI paging contract

The original first GPU-cwd thread from native `thread/list` retained its ID and
history; no replacement thread or fork was created. Metadata reported
`historyMode: "paginated"`. The installed public renderer program
`webview/assets/app-shared-cc1fe93eb683.js` defaults to tail hydration and
paginated history, and this native version exceeds its pagination capability
minimum `0.145.0-alpha.15`. For a local paginated thread, its `Mnn` resume path
excludes turns, then `_nn`/`EV` hydrates bounded turns and items. The legacy
`initialTurnsPage: {limit: 5, itemsView: "full", sortDirection: "desc"}` branch
is not required for this thread.

The exact bounded product-owner shape was exercised without printing content:

```json
{
  "resume": {"excludeTurns": true},
  "turns": {"cursor": null, "limit": 5, "itemsView": "notLoaded", "sortDirection": "desc"},
  "itemsPerTurn": {"cursor": null, "limit": 100, "sortDirection": "desc"}
}
```

The same original ID resumed successfully. Five latest turns and 171 items
were returned, including user/agent message and tool-item metadata. Turn
metadata was 1265 bytes; the five item frames were 1913, 2826, 428191, 139851
and 169382 bytes. All five per-turn item cursors were exhausted, while an older
turn-page cursor remained. The largest tested frame was 428191 bytes.
The root receipt independently records `installedGuiHistoryQueryShapeVerified`
and original-ID history acceptance as true, five turns, 171 items and zero
model turns. No credentials or transcripts were printed.

### Explicit acceptance limits and remaining deployment boundary

Full unpaged history is **not** covered by this accepted contract. A direct
native diagnostic proved that the same original thread's full history exists
(17 turns / 1801 items), but its complete frame was 24011614 bytes. That exceeds
the intentionally qualified broker limit of 8388608 bytes (8 MiB); the original
unpaged verifier consequently received an admission-uncertain response. It was
not a missing rollout, writer conflict or absent history. The authoritative
GUI acceptance above uses the actual installed paginated contract and does not
relax that transport limit.

Only the latest five history turns and their bounded item pages were exercised
through the product route. Older pages, every other GPU thread, the actual
previously selected desktop thread, real model submission/cancellation and
Windows desktop migration are not claimed by this readback.

At `22:07:50 UTC`, the root reported starting the external supervisor
`code-ai-native-unlock-resume-aff5bbc8` for the remaining Ubuntu core and main
replacement using the same immutable artifacts. That report is coordination
metadata, not independent evidence here that those remaining deployments
completed. No additional installation or legacy-history traversal was performed
by this documentation closure.
