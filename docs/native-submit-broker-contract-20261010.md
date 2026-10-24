# Native shared-owner submission contract (2026-10-10)

## Decision and boundary

Reuse the installed, unmodified OpenAI Codex app-server, native durable queue,
writer coordination, history, model runner, and question protocol. The selected
foundation is upstream Codex (Apache-2.0), qualified here on `0.162.1` and Ubuntu
desktop's `0.162.0-alpha.2`. Use the existing `ws` dependency for transport.
Code AI owns only a same-UID private-UDS admission adapter and a bounded
metadata-only reservation journal. It does not create a transcript, copy a user
prompt into a second store, remove a writer lock, or implement another agent.

Retain the existing JSONL/Unix-WebSocket bridge, stable client message IDs,
question registry and cancellation reconciliation. All cooperating GUI, IDE,
and Code AI clients must enter through the same adapter into one native owner.
A direct backend connection by an uncooperating same-UID process is outside
this boundary; the private native socket is not an isolation boundary against
malicious processes running as that UID.

Rejected alternatives:

- Deleting native locks or rewriting live SQLite/rollout files can corrupt ownership/history.
- `turn/start` on a busy thread can steer its current desktop turn; it has no
  atomic idle precondition. It is not a safe independent submission fallback.
- A second native owner can enqueue an unloaded persisted thread, but cannot
  receive or answer its running questions or interrupt its turn. It also cannot
  pin per-submission execution settings. That path is not full integration.
- Forking native storage/execution would duplicate an upstream engine instead
  of closing the product-owned admission gap.

Primary upstream reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server).
Installed source evidence was inspected under
`/mnt/hdd/code-ai-builds/openai-codex-reset-research-6e6LP7/source`, particularly
`app-server/src/request_processors/thread_queue_processor.rs`,
`request_processors/turn_processor.rs`, `ext/queue/src/service.rs`,
`core/src/session/step_settings.rs`, and `app-server/src/outgoing_message.rs`.
Installed-binary synthetic results, not source inspection alone, qualify the
claims below.

## Product protocol

Successful adapter initialization adds:

```json
{"codeAiSharedOwner":{"version":1,"turnSettings":true}}
```

Code AI must require this marker before managed thread/submission operations.
A raw native daemon silently ignores unknown queue fields and must never be
treated as supporting this product contract.

The product `thread/queue/add` request adds:

```js
codeAiTurnSettings: {
  model, effort, cwd, approvalPolicy, sandboxPolicy
},
codeAiExpectedCollaborationMode: 'default' // or explicit 'plan'
```

The settings object has exactly those five public fields. Existing native
input/clientUserMessageId fields remain unchanged. The adapter removes product
fields before forwarding to native queue/add. Mode is validated, not changed;
an absent expected-mode field means Default. Code AI must not silently inherit
GUI Plan restrictions or claim arbitrary mode/instruction pinning.

An optional `codeAiExpectedOwnerSettings` can enforce a stricter immutable
baseline; it is not a prerequisite for the five-field scoped reservation.

## Admission and custody

1. Serialize cooperating writes per thread; reject a second product reservation
   before delivery. Require the native queue to have no preceding foreign input.
2. Read the actual native settings, not global config or guessed thread fields.
   Persist original/requested public settings and a proved mode enum before
   publishing future settings. The journal never stores prompts or instructions.
3. Apply requested future model, effort, cwd, approval and sandbox. Native ACK
   only acknowledges an asynchronous Op, so require its applied notification
   and authoritative readback. Native suppresses no-op notifications: a proved
   unchanged request is answered without enqueueing a redundant Op.
4. Compare actual Default/Plan mode before queue custody. On mismatch/unknown,
   restore five settings and return known-not-accepted. Never overwrite native
   mode or developer instructions to manufacture a match.
5. Persist the enqueue-attempt fence, then use native queue/add. Only the native
   user item's stable client ID proves which subsequent turn is ours.
6. Once that item proves dispatch, restore original *future* defaults. Native
   current-turn captures keep the requested settings; the active desktop turn
   keeps its own earlier captures. Protect the owned active turn against
   foreign turn/settings/update until native terminal evidence arrives.
7. Foreign settings/start/queue/config mutations while next-turn settings are
   reserved get bounded known-not-accepted errors; no arbitrary prompt is
   silently held, timed out, or replayed. Native question/approval answers bypass
   the request fence to avoid deadlocking the existing desktop turn.
8. Confirmed pending delete restores original defaults. Started-turn deletion
   does not guess cancellation. An explicit, stable-ID-proved own interrupt uses
   native turn/interrupt. Unknown enqueue ACK keeps custody unresolved and never
   replays input or claims cancellation/completion.

A brand-new native thread cannot be resumed before its first rollout exists.
For that specific native thread/start result, the adapter uses the just-returned
authoritative start snapshot until its first user item. The native constructor's
Default mode and no-op-settings admission are proved on both installed binaries.
Loaded historical threads never get this fallback or a guessed Default mode.
Native queue remains the executor even for the first submission.

## Lifecycle and exact limits

The adapter journal is private (0700 directory / 0600 file), atomically renamed
and fsynced, schema/bounds checked, and records only IDs, public execution
settings, phase/time, proved mode enum and terminal evidence. Recovery checks
native history and native queue; it never replays a prompt. Absence from one
snapshot does not prove nondelivery. An unresolved reservation remains guarded.

Frontend EOF retains its backend connection while native pending/running
custody exists. A late same-owner resume replays the pending native question;
the adapter does not fabricate an answer. Adapter process restart recovers
metadata before accepting frontends, without restarting the native owner.
Actual fixtures prove both paths. The service installer still owns private
runtime directories and safe lifecycle management of its own endpoint.

The adapter refuses before input delivery when restoration cannot be proved:

- unknown or incompatible Default/Plan mode;
- explicit non-null effort when previous native effort is null (public null
  does not clear it);
- cwd changes with multiple environment/workspace roots;
- named permission profiles whose fine-grained rules/provenance cannot be
  reconstructed from the legacy sandbox snapshot;
- preceding foreign native queue entries, uncertain custody, failed journal,
  or unresolved prior applied-settings/config writes.

This is not permission bypass or broad multi-writer native history support.
Approval policy/sandbox changes are scoped to the existing Code AI selected
turn contract and restored for future GUI work. Authentication is untouched.
No secret, config/environ dump, installed setting, live history, or real account
was used by the qualification fixture.

## Verification and handoff

The public receipt is `ops/native-owner/native-protocol-contract-20261010.json`.
`server/codexSharedOwnerBroker.test.mjs` covers pure reservation/race/error/recovery
logic. `scripts/codex-native-submit-contract.mjs` uses disposable private
CODEX_HOME, HOME/workspaces and one fake loopback HTTP provider; it launches real
installed native executables, the real adapter, and the existing stdio bridge.

Required deployment checks are separate: all actual cooperating clients use the
private common-owner endpoint; Code AI requires the handshake; real native GUI
remains on its exact same thread; live questions/answers and cancellation use
proved ownership; host-specific package/binary/runtime readback passes. These
fixtures are not a claim that GUI migration or deployment is already complete.
