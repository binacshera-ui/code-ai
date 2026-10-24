# Native conversation ownership — focused continuation

Request: allow Code AI to submit to a conversation also open in native Codex,
and deploy only an actually qualified implementation. The already accepted
application release is `06247301-58b8-4ec4-82cc-2c96f0b22a4d`.

## Foundation decision

Retain OpenAI Codex's app-server, durable queue, native history, and writer
coordination. Retain Code AI's existing JSONL/Unix-WebSocket adapter, durable
submission IDs, question registry and cancellation reconciliation. Do not
delete lock inodes, invent another history writer, or fork user conversations.
The upstream app-server documentation and installed native protocol were
inspected; native queue items currently have no submission-specific model or
MCP configuration. A new custom core is not selected.

Installed Ubuntu program: `/usr/lib/chatgpt/resources/codex`, version previously
identified as `0.162.0-alpha.2`; recheck before activation. Desktop program code
supports `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`, subject to launch constraints.
The direct daemon transport is the recommended integration boundary, not a
replacement for native Codex. Its runtime keeps ownership of the transcript.

## Newly verified defect

The service's `lstat` preflight rejects symbolic links. Native Codex's canonical
socket is legitimately a symlink into a private per-user temporary directory.
The existing bridge already validates both ends and permits this native form.
Fix the preflight to use the same same-user/private-directory contract; never
permit an arbitrary symlink merely because it points at a socket.

The currently observed Ubuntu canonical link is dangling; no successful live
daemon connection has been claimed. The desktop currently uses an independent
stdio owner. Windows SSH port 44022 refused the connection during this audit.

## Acceptance ledger (pending, not deployment evidence)

- Real native canonical symlink accepted; foreign/public/dangling endpoint denied.
- GUI and Code AI use the same profile/UID and native writer owner.
- Idle GUI does not prevent submission; busy GUI does not receive unintended steer.
- Requested execution settings and mode context have a documented, proven contract.
- Only our proven turn/question may be answered, cancelled or completed.
- Accepted input survives client disconnection without duplicate submission.
- Cumulative application build retains the accepted release; authentication unchanged.
- Each accessible host has an independent live readback and rollback target.

No native GUI stop, authentication rotation, inode removal, or shared-feature
activation has been performed by this continuation at the time of this record.

## Completed deployment and fresh verification

The preceding pending ledger is historical. Deployment completed at
2026-10-10 22:12:31 UTC, with independent read-only verification repeated on
2026-10-11 04:42:45–04:42:55 UTC after the interrupted conversation resumed.
No deployment or restart was repeated during this final verification.

- Application release: `b6196953-8f40-4acb-a040-1b31a912bea6`.
- Native-owner controller: `aff5bbc8-e0a0-4d34-8bd1-a04f42a95036`.
- Main: PID 4192381; profiles `developer`, `developer2`.
- BEAM: PID 3922999; profiles `beam-root`, `beam-admin`.
- PCI: PID 1732363; profile `pci-admin`.
- Ubuntu: PID 499715; profile `ubuntu-refael`.

All four retained the exact activated process generation, qualified application
hash, enabled shared-owner profiles, active owner services and matched native
home/owner probes. Main public HTTPS assets and the upload API also passed.
Transaction evidence records byte-preserved installed authentication and pairing
configuration, queue backups and preservation of nonterminal queue record IDs.
This is not a claim of uninterrupted running jobs: interruptions were authorized.

Ubuntu's GUI was normally closed and relaunched during activation. Process-chain
and socket-peer evidence established that the real GUI and Code AI use the same
native owner. The existing GPU thread was resumed with its original ID using the
installed GUI's paginated history protocol: five latest turns and 171 items were
read. No real model turn was submitted as a live acceptance test. Qualification
also included actual-native synthetic fixtures and broker/CLI/stdio tests.

The implementation retains one native history writer and queues cooperating
clients; it does not delete lock inodes or bypass active-turn coordination.
Independent clients that bypass the configured shared route are not covered.
Unsupported execution-mode/permission combinations still fail closed. Unpaged
history responses larger than the qualified 8 MiB frame limit remain unsupported;
the actual GUI pagination path was verified instead.

Windows was not deployed because its SSH endpoint was unavailable. No successful
Chrome visual audit is claimed. No credentials were rotated.

Evidence:
- `ops/native-unlock-release/final-receipt-b6196953-8f40-4acb-a040-1b31a912bea6-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json`
- `ops/native-unlock-release/verify-installed-host.mjs` (fresh read-only checks).
- `docs/native-gui-closure-20261010.md` (actual GUI and history evidence).

Earlier failed receipts remain intact. Their resolved gates involved a zeroed
Electron parent environment (verified through live children/socket peers), an
incorrect unpaged-history assumption, and an external supervisor missing the
explicit main-server `PM2_HOME`. The successful final supervisor pinned the
correct PM2 store and did not repeat already completed remote activations.
