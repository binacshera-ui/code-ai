# Queue persistence and low-latency acknowledgement

The queue engine and its existing shared native owner remain authoritative.
SQLite is a persistence replacement, not a second queue runner. After migration,
`.code-ai/queue/queue.sqlite` is authoritative; `state.json` is migration evidence
and **must not be used to decide current safety, status, or dispatch**.

The Node SQLite connection runs in one worker thread. FULL synchronous WAL
transactions commit changed items, order, deletions and bindings before a request
can acknowledge acceptance. A stable `clientRequestId` deduplicates uncertain
manual retries; a duplicate result crosses the same durable barrier.

An existing but corrupt/uninitialized SQLite database fails closed. It must never
silently resurrect `state.json`. Migration verifies row counts and canonical
payload/binding hashes and does not remove original failures or native IDs.

Background polling requests `/api/codex/queue/items?view=compact`. This bounds
terminal history, never live/uncertain work. Opening queue details requests the
compatible full view. `/api/codex/queue/history` supplies cursor pagination for
terminal history; session recovery reads full targeted SQLite projections.

The client releases its send lock after durable POST acknowledgement. Refresh is
background work. Immediate single-flight and scope/revision checks protect rapid
clicks, stale reads, navigation, new text and new attachments.

## Operations

- Do not copy only a live `.sqlite` main file: WAL may contain committed data.
  Use SQLite's online backup API or an explicit consistent export supplied by
  the store. Never truncate WAL/SHM or delete owner locks.
- On the main server, the private hash-pinned
  `.code-ai/local/runtime-activation.json` selects the compatible immutable
  successor at the next normal startup. Keep it while SQLite is authoritative.
- The October 29 live transition reused the existing owner process. It did not
  restart PM2, cancel native work, override drain qualification, or start another
  queue writer. See `.code-ai/operations/send-latency-20261029` for receipts.
- Returning to a JSON-only runtime requires fencing ingress, settling its writer,
  exporting a **current** consistent SQLite snapshot and qualifying the reverse
  handoff. Merely selecting an older release is unsafe.
- Preserve old static assets while already-open clients can still request chunks.

Acceptance latency is separate from provider capacity and model generation time.
Benchmark both local API and the real public browser path; do not present a local
commit microbenchmark as end-user latency.
