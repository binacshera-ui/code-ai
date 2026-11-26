# DeepSeek models on the Codex harness

DeepSeek is an additional model family in Code AI's existing Codex picker. It is
not another CLI, agent loop, conversation store, or Bina Cshera proxy. Native
Codex owns tools, history, resume and local context compaction.

## Registered providers

| Picker model | Exact upstream model | Responses endpoint |
| --- | --- | --- |
| `deepseek-v4.1-flash-venice` | `deepseek-v4-1-flash-1017-uncensored` | `https://api.venice.ai/api/v1/responses` |
| `deepseek-v4.1-flash-experiential` | `deepseek-v4.1-flash-uncensored` | `https://api.experientiallabs.ai/v1/responses` |

These are the two provider-specific uncensored Flash variants, not the official
DeepSeek API's `deepseek-chat` alias. Both use direct Responses requests from the
loopback inference router. The existing LiteLLM adapter remains Gemini-only.
OpenAI account credentials and account headers must not cross either provider
boundary. API usage is billed by the selected provider, separately from the
ChatGPT subscription and its quota stop. OpenAI speed tiers are not advertised
for these API models.

## Private credentials and provisioning

Prepare a private Code AI-owned environment file outside the repository with
`VENICE_API_KEY` and `EXPLABS_API_KEY`. Restrict it to mode `0600`. Do not place
keys in Codex's model catalog, config, settings JSON, adapter YAML, shell command
arguments, logs or source control. The runtime must not read another product's
environment file or call its services to obtain credentials.

Extend the existing Gemini-enabled inference installation:

```bash
node deploy/code-ai/inference/install.mjs \
  --runtime-root /srv/code-ai-inference \
  --codex-home /home/example/.codex \
  --key-file /srv/code-ai-inference/gemini.env \
  --provider-key-file /srv/code-ai-inference/provider-keys.env
```

Repeat `--codex-home` for each managed native profile. Both provider keys must
be present before either DeepSeek catalog entry is enabled. Invalid credentials
file configuration fails before profiles or runtime files are changed. The
installer validates presence and file privacy, not provider account balance or
key authorization; only live provider tests establish those properties.

The generated settings store only the private credentials file's path. Native
authentication, selected model, reasoning effort, service tier and MCP entries
are preserved. Existing GPT catalog capabilities are retained. A later normal
installer rerun preserves the configured provider file and inference ports.
An installation without that file remains GPT/Gemini-only.

The installer does not restart any service. Deploy a qualified router release
with graceful draining, then reload idle native owners only if the installed
Codex version needs a configuration/catalog refresh. Do not cancel active user
work to refresh models.

## Conversation compatibility

Threads created under the shared `code_ai` provider can select GPT, Gemini or
either DeepSeek provider for the next turn while retaining their native thread
and tool history. A model selection does not interrupt or replace a running turn.

Sealed `encrypted_content` is provider/account state, not a portable transcript
or an uploaded file. The router records only its SHA-256 fingerprint, source
provider/model and authentication scope in private `provider-state.sqlite`
under the inference runtime root. It observes JSON/SSE output without changing
response bytes. Replay requires the same provider endpoint and account (or API
credential scope); item IDs and the presence of ciphertext are not proof of
ownership. The registry survives router restarts and never contains ciphertext,
reasoning text, API keys, or OAuth tokens.

At the transport boundary, foreign or unverifiable legacy **reasoning** items
are excluded from that request only. The native transcript, visible messages,
and exact tool call/result pairs remain unchanged. Valid recorded same-scope
state is retained, including after switching away and back. Existing untracked
reasoning is omitted rather than guessed to be decryptable by OpenAI.
No failed turn or business operation is automatically replayed. An unverifiable
encrypted **compaction checkpoint** is rejected explicitly rather than silently
discarding the conversation's only remaining history.

Historical threads pinned to Codex's built-in `openai` provider retain the
existing compatibility limitation described in [the Gemini integration](codex-gemini.md).
Codex 0.171 rejects changing their provider identity on resume. Do not rewrite
their transcripts or globally replace OpenAI's endpoint to claim support:
built-in remote compaction has a different contract.

## Verification and accounting

The chosen foundation is the existing native Codex 0.171.0 harness (Apache-2.0)
and its configured `code_ai` Responses boundary. Both providers' own Responses
implementations passed custom/namespace tool and streamed tool-result spikes.
An additional LiteLLM bridge was therefore unnecessary for DeepSeek; the pinned
LiteLLM 1.110.1 integration remains unchanged for Gemini. No second agent loop or
new third-party runtime dependency was introduced.

Codex 0.171 keeps model metadata in already-loaded threads. For an idle existing
API-model thread, Code AI resubscribes with its already-configured catalog path,
without model, permission, effort or provider overrides. Public settings must
remain identical. Active/queued work and recovery of accepted inputs are never
unsubscribed or resubmitted for this refresh. This refresh does not restart the
native owner or rewrite the transcript.

Run `node --test deploy/code-ai/inference/install.test.mjs` for provisioning and
`node --test server/codexInferenceRouter.test.mjs` for transport boundaries.
Run `node --test server/codexProviderState.test.mjs` for state ownership,
legacy-history handling, private persistence, and chunked UTF-8/SSE parsing.
Release qualification must separately exercise both exact provider models with
real Codex tools, follow-up turns, model switching and resume. A successful
plain-text request alone is not proof that the agent harness works.

For a disposable workspace, the live qualification supports
`--models=deepseek-v4.1-flash-venice,gemini-4-neon,deepseek-v4.1-flash-experiential`.
It makes real billable calls and creates one harmless `.txt` fixture per
DeepSeek model to prove native shell and freeform patch tools. It continues the
same thread through provider switches, process restart and native compaction.

Preserve provider-reported input, output and cache telemetry; missing cache
detail remains unknown, not zero. Do not create paid cache objects, warm-up
requests or retention extensions to manufacture cache hits. Provider catalog
prices are estimates, not proof of a reconciled account charge.

Primary protocol references: [Venice Responses](https://docs.venice.ai/guides/features/responses-api)
and [Experiential Responses](https://docs.experientiallabs.ai/docs/responses).
