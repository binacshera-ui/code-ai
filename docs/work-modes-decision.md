# Bounded work and operator decisions

Scope: Code-AI on the main Germany server only. Preserve native history, the shared
writer, selected context packs/reminders and Codex's own memory configuration.

Foundation decision (2026-10-20): retain the existing queue, its exact-run
cancellation, notification outbox, focus preference and incident decision center.
The existing persisted subtasks have checkmarks but no runtime budget. The incident
center already owns cases/tickets and their messages; do not create another ticket
database. A small per-run budget state supplements, rather than replaces, these
owners. A restart rechecks persisted absolute deadlines, never resets the clock.

Temporal's approval/signals pattern covers durable human decisions but requires
another runtime and migration of the existing queue. XState persistence supplies
state snapshots but does not itself own our native cancellation/outbox/ticket
integration. Neither is added: these specific capabilities belong at the existing
queue and incident-center boundaries. No dependency or framework installation.
References: https://docs.temporal.io/design-patterns/approval and
https://stately.ai/docs/persistence .

Product contract:

- Engineering judgement remains available. Rational mode adds a bounded planning
  window followed by a frozen, ordered task plan with minute estimates and explicit
  completion evidence. Runtime, not prompt text, enforces the current deadline.
  The AI, not the operator, chooses the planning estimate before investigation
  through the run-scoped `budget` action, then chooses an estimate for each task.
  New runs ignore the old per-conversation planning/task limits. The UI only
  enables/disables the mode and displays the AI's saved estimates and countdown.
  The planning estimate is frozen too; the model cannot extend it. A short
  declaration watchdog bounds failure to declare any budget and is explicitly
  distinguished from the AI-selected planning time. Historical in-flight runs
  retain their original deadline/cap rather than having their clocks reset.
- An expired unfinished task stops only its owning run, holds subsequent automatic
  work in that conversation, and uses the existing notification outbox once. No
  automatic deadline extensions or retries. The owner can explicitly release it.
- Decision mode parks an identified support case in the canonical incident center,
  with its original session and ticket. It consumes no running model while waiting.
  A saved owner verdict wakes that same case/session idempotently. A reply or
  successful model turn is not proof that the ticket is resolved.
- UI exposes persisted plan/checkmarks/deadline and decision inbox; reopening and
  device changes read server state. New runs receive a narrowly scoped local
  control capability, not an administrative API token or another native writer.
- Test exact capacity handling, budget expiry/completion/restart/isolation and
  decision-save/wake/retry against isolated state, then build and browser-check.

Local dependency check changed the dispatch selection: failure-handling is healthy
on 18210, not the previous default 8210 (which serves conversion-hub). The old
incident Temporal stack is absent and its callback authentication is unconfigured;
manual cases do not start that workflow either. Do not revive that unrelated
global stack. New Code-AI operator verdicts dispatch through the existing Code-AI
queue immediately, keyed by the canonical case and decision IDs. Existing legacy
workflow callbacks are an external compatibility caller of the same admission
owner and normalize to the same ID, so a delayed callback cannot submit the
verdict twice. Case storage stays canonical; linked-ticket closure is never
inferred from an investigator's completed turn.
