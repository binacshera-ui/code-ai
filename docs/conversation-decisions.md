# Conversation decisions

## Foundation decision (2026-11-01)

Retain Code AI's flow-workspace integration pattern, existing conversation queue,
native question adapter and installed React 19.3.0 / Radix Dialog 1.2.0 (MIT).
React controlled form inputs own the small answer editor. Radix supplies modal
focus, keyboard and dismissal behavior. No canvas engine, form framework,
workflow scheduler or external ticket system is needed.

Primary references examined:

- https://react.dev/reference/react-dom/components/input
- https://www.radix-ui.com/primitives/docs/components/dialog
- https://www.radix-ui.com/primitives/docs/overview/accessibility

The existing `CodexUserInputRegistry` can answer a live native request in its
original turn, but is process-local and prunes resolved records. It is not a
durable decisions database. The incident decision center owns support tickets,
not ordinary conversation choices. Reusing either as the generic store would
lose reopening semantics or invoke unrelated support workflows.

## Product contract

| Journey | Boundary |
| --- | --- |
| Open decisions beside the map launcher | Lazy conversation-scoped modal, not a large block above the transcript |
| Approve / reject | Explicit ✓ / ✕, neither preselected |
| Choose one or several options | Stable option IDs, keyboard-operable controlled inputs |
| Add a comment or free answer | Optional comment beside decisions, required text for a text question |
| Save and reopen | Private per-conversation revisioned state; original transcript stays immutable |
| Deliver to the assistant | Explicit send; immutable batch and stable idempotency key into the existing queue |
| Answer a live native question | Its existing RPC adapter, not another queued prompt or permission grant |
| Agent publishes a decision set | Bounded `code-ai-decisions` JSON block; answered questions cannot be overwritten |
| Change device/session or encounter a conflict | Server state and revision conflict; no stale request can overwrite another conversation |

Saving an answer is not sending it, and sending decisions is not proof that the
requested work completed. A business approval never changes execution permissions.

The board has one canonical domain schema in `shared/decisionBoard.ts`. Its
persistence service does not import the queue module or create a model owner.
Queue admission is injected by the existing authenticated runtime. Private
revisioned per-conversation files keep this feature off the whole-history JSON
write path that previously caused send latency.

New conversations retain the board when their draft key is bound to a real
session. Disabled mode retains its records. AI-produced definitions may add or
update unanswered questions, but never erase operator answers or relabel an
answered question in place. Original support cases and native secrets are not
copied into this store.

Acceptance covers all four answer types, save/reopen, optimistic conflicts,
duplicate/ambiguous delivery, per-profile isolation, AI ingestion, draft rebinding,
native question compatibility, production build and the relevant real-browser
journey in light/dark and narrow layouts.
