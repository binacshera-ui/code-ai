# Native Codex questions and Markdown assets — design decision

## Reuse gate

The existing ReactMarkdown renderer and authenticated file resolver remain authoritative.
Local Markdown images lacked an `img` renderer; browser media cannot send the custom
server-routing header. HTML was classified as source code with no interactive preview.
The existing resolver continues enforcing allowed roots and real paths; no new public
file service is introduced. HTML dependencies use a directory-scoped namespace.
The authenticated parent prepares the document and inlines local resources before
putting it in an opaque-origin `srcDoc` sandbox, without Code AI API access or
same-origin privileges. Native DOMParser and the already-locked MIT PostCSS 8.5.6
are reused; PostCSS is now explicitly pinned as a build dependency.

Real Chrome demonstrated why a protected `iframe src` is insufficient: its initial
HTML request had the synthetic SameSite=Lax cookie, while opaque-origin child CSS,
JavaScript and image requests omitted it and received 403. A gateway that injects
authentication into every request masks this defect and is not cookie-contract proof.
The revised QA gateway translates only its unique browser-owned synthetic cookie,
never injecting credentials when absent. It never forwards actual device cookies.

Only directory-scoped HTML, script/style and image/font/media dependency types may
be loaded by the parent. Arbitrary API URLs, escaping paths, redirects and credential
URLs are rejected. External HTTPS resources run in the sandbox only. The sandbox
disallows application network requests, forms, nested frames and same-origin access.
Dependencies and output have explicit byte/count/depth limits and an abort signal;
source changes cannot reuse a previous prepared document. Missing dependencies are
reported as partial previews rather than silently claimed as complete.

This is a standalone HTML preview, not a local application server. Module import
graphs, dynamic API requests, application-origin browser storage and unsupported
CSS import qualifiers are not promised. The user's supplied 153KB standalone CRM
demo has no module imports or external script/style dependencies.

The installed Codex CLI is 0.160.1. Its own generated app-server schemas define
`item/tool/requestUserInput`, `isBlocking`, typed questions and an answer map. A
synthetic-home initialize/initialized stdio spike succeeded without a model turn.
The official native app-server is the selected engine, not a second orchestrator or
plain-text question parser. Dependencies remain the existing React, Express and CLI.

## Contract

- Requests are scoped to source server, profile, parent session and run. Nested native
  thread IDs remain protocol metadata, not a new conversation in the UI.
- An answer completes the exact native server request in the ongoing turn. It never
  sends the composer draft or enqueues another prompt. Retry is idempotent; expired
  or mismatched requests cannot be answered.
- Blocking and asynchronous questions are distinguished. Native lifecycle cleanup,
  cancellation and transport failure expire pending requests. Browser closure does
  not cancel a request. Secret answers are redacted in this control registry and its
  question receipts. Native provider-owned transcript retention is unchanged; this
  integration is not a promise that the provider never records a submitted answer.
- Existing queue ownership, prepared provider homes, browser leases, permissions and
  original session histories must be preserved. Unknown authorization requests fail
  closed; ordinary questions cannot grant a shell permission.
- Questions use the installed protocol's experimental capability explicitly. No
  experimental WebSocket transport or unfinished plugin APIs are enabled.
  The installed 0.160.1 `default_mode_request_user_input` feature is opt-in and
  labelled under development; it is enabled only on each Code AI-owned run, not
  written to account configuration. Default execution mode remains unchanged.
  Older remote CLIs must be qualified against this contract before activation;
  there is no automatic replay through `exec` after a failed native turn.

## Qualification and rollout

Compilation and regression qualification run on the BEAM builder. Use synthetic
RPC peers to prove request/answer/resolution/cancellation and scope errors without
paid model execution. Verify Markdown images and sandboxed demo controls in a real
browser against an isolated imported build; qualify remote source routing and unsafe
URLs separately. Do not label mobile or real-account inference as passed without an
actual corresponding check.

The German runtime owns singleton file-backed queues. Source changes are not a live
activation. A candidate must not lease production queues while qualifying. Activation
requires drained jobs or a proven checkpoint handoff; a PM2 reload is not automatically
safe. Preserve active and rollback artifacts and never delete session transcripts.

## Official sources consulted

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/models
- https://learn.chatgpt.com/docs/changelog (0.160 and 0.160.1)

Relevant current capabilities include native user-input requests and lifecycle cleanup,
turn steering, authoritative model discovery/effort levels, and reconnect fixes for queued
input. These are distinct capabilities: this change does not automatically enable every
new feature, select a different model, or claim an account has access to every model.

## Qualified candidate and activation status

BEAM build `7e837f6f-708d-498b-835d-f4bcb3453a78` passed 102 Node regressions and
18 Markdown/component checks, the production build, and five isolated real HTTP/
queue/native-protocol check groups. Its verified imported artifact is recorded in
`ops/codex-interactive-release/qualification-20261007.json`. No real model turn or
account change was performed.

Real personal Chrome showed the actual 1920×1058 CRM screenshot in Markdown, both
question types answered inside one queued turn while preserving the composer, and
authenticated parent HTML/CSS/import/image/script requests returning 200. The
sandbox's executed document had origin `null` and could not access the parent DOM.
The original CRM rendered in Hebrew/RTL with 78 post-script buttons and no observed
JavaScript errors. A QA-only probe inside the sandbox programmatically clicked
“עסקה חדשה” and opened its form. That is not a claim of a complete manual pointer
or mobile audit. Original files were only copied and were not edited.

Visibility/lazy-image overrides were used solely for background-browser qualification.
The final artifact's optional additional reload measurement could not complete after
the isolated helper exited cleanly and removed its fixture; prior browser question
reload/cancellation evidence belongs to the preceding candidate with the unchanged
question contract. Native JSONL/API reopen passed on the final candidate itself.

The candidate is **not live**. At the final metadata check, five production jobs
were running, one was scheduled, and the active server hash still matched the
accepted baseline. No restart, reload, queue cancellation, authentication change or
history deletion was performed. Safe singleton activation remains a separate gate,
not a promise of automatic or interruption-free deployment.
