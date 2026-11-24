# Subscription quota stop

The stopwatch row inside the usage panel configures a server-owned stop for a
Codex/ChatGPT subscription account. It starts disabled; the operator chooses a
used-percentage threshold and the primary, secondary (usually weekly), or first
matching window, then explicitly saves. Fractional percentages are accepted,
but their measurement precision remains that reported by the provider.

## Existing foundation and decision

The implementation reuses native Codex 0.171 history, interruption and queue
RPCs, Code AI's existing authenticated account-usage reader, durable queue and
the current React/Radix UI. It does not create an agent, compactor, alternative
quota estimator or prompt replay loop. No new dependency is needed.

Opossum (Apache-2.0, upstream nodeshift/opossum, inspected 2026-11-24) was
considered: its failure-count circuit breaker does not own subscription
percentages, persisted account identity, or native turn cancellation. Adding it
would not replace the product-specific rule. The existing local primitives are
the selected foundation. Native account rate-limit notifications, read and
turn interruption are documented at https://developers.openai.com/codex/app-server.

## Scope and enforcement

- One hashed account binding shares the setting across all profiles using that
  subscription. Credentials, raw account IDs and conversation contents are not
  stored in the policy. A stale account-editor draft cannot configure a newly
  logged-in account.
- The server polls while enabled, independently of any open browser, and stores
  a confirmed threshold latch before interruption. Missing or delayed usage is
  not evidence of a breach and never initiates cancellation. It also never
  clears a confirmed stop. An unknown number is never interpreted as zero.
- Windows are selected by their reported duration, not provider slot position:
  Pro Max can report its only weekly window in `primary` with `secondary: null`.
  "Any" evaluates the available windows, without requiring two windows to exist.
  The stored legacy keys `primary`/`secondary` select short/weekly respectively.
- New messages, direct runs, retries and scheduled/recurring/automatic starts
  must pass admission. Drafts remain editable. Waiting work is stopped, not
  deleted, and is not silently replayed after release or a quota reset.
- Active Code AI runs are interrupted through their existing handles. Accepted
  native inputs with uncertain custody retain their IDs and are reconciled for
  cancellation, never resent. An interrupt acknowledgement alone is not proof
  that a native turn has terminated.
- The shared native owner is scanned for loaded active threads, including
  subagents. The actual turn model is read from native turn metadata; changing
  the picker cannot disguise a subscription turn as an API turn.
- Gemini models routed through a separately billed API and API-key-only
  profiles are not charged against this subscription and are exempt.
- The inference service reads the same policy using `quotaStopStateFile` in its
  private settings (or `CODE_AI_QUOTA_STOP_STATE_FILE`). This fences every new
  subscription model/image request and closes in-flight streams when blocked.
  Installer `--storage-root` must point to the API's storage root.

The UI shows a countdown to the **provider's quota reset**, not an invented
time-to-exhaustion forecast. Provider reporting delays and work already sent can
cause an overshoot; this is not a token-exact spending guarantee. Separate
standalone CLIs or processes outside Code AI's queue, shared native owner and
configured transport are outside the application control boundary.

Disabling or raising the threshold is an explicit operator action. A clock
passing a reset timestamp does not alone prove a reset; fresh provider data is
required. Histories and unfinished prompts remain available for manual review.
