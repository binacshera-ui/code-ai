# Gemini models inside Code AI's Codex harness

Gemini is a model family in the existing Codex model picker. It is not a Gemini
CLI conversation or a copied Codex home. GPT and Gemini share the native thread
ID, transcript, shell/patch/MCP tools, approvals, resume and local compaction.
Switching the picker affects the next submitted message, never a running turn.

## Transport

Codex's `code_ai` Responses provider connects to the loopback inference router.
GPT requests retain their normal account authentication and go to the OpenAI
Codex endpoint. The four registered Gemini 4 models go to the loopback LiteLLM
adapter, which uses the existing Gemini CLI API key. OpenAI credentials and
account headers are never forwarded to Google. Gemini API usage is billed
separately from the ChatGPT subscription.

The router translates transport only; Codex remains the agent runtime. Opaque
OpenAI reasoning is omitted from Gemini-bound input. Long Gemini thought-signature
tool IDs are mapped consistently for OpenAI's ID limit when switching back. The
native transcript is not rewritten. OpenAI-hosted search and OpenAI speed tiers
are not Gemini capabilities; authorized MCP tools remain available.

## Provision

Choose private runtime paths outside source control. Install Node.js, Python, uv
and the existing Codex binary, then:

```bash
uv venv --python python3 /srv/code-ai-inference/venv
uv pip install --python /srv/code-ai-inference/venv/bin/python 'litellm[proxy]==1.110.1'
node deploy/code-ai/inference/install.mjs \
  --runtime-root /srv/code-ai-inference \
  --codex-home /home/example/.codex \
  --key-file /home/example/.gemini/.env
node deploy/code-ai/inference/serve-adapter.mjs /srv/code-ai-inference
node server/codexInferenceRouter.mjs /srv/code-ai-inference/settings.json
```

Run the last two programs as supervised services. Both bind loopback only.
Use repeated `--codex-home` arguments for multiple normal Codex profiles. Install
preserves configuration backups, writes a combined native model catalog, and
selects the shared `code_ai` transport without changing the selected GPT model
or its authentication. Ports default to 4188 (router) and 4189 (adapter).

Existing native owners must reload configuration when idle. A loaded thread's
provider cannot be changed by a turn settings update. Do not cancel active work
to reload: the one-time `restart-idle-owners.mjs` operator accepts private JSON
with `owners: [{service, socket}]` and a `receipt` path. It checks native active
turns and queued inputs before restart and verifies the transport/catalog after.
Resume unloaded historical threads with `modelProvider: "code_ai"`, keeping the
original thread ID. Recovery of already accepted inputs must not change settings
or submit the original input again.

## Qualification and accounting

Run focused router tests with `node --test server/codexInferenceRouter.test.mjs`.
`deploy/code-ai/inference/verify.mjs HOME WORKSPACE RECEIPT` qualifies a disposable
test thread: original GPT, all four Gemini models with real native shell tools,
return to GPT, process restart/resume and native compaction. It makes real API
calls. Verify the actual Code AI queue/model picker separately after deployment.

Keep credentials, transcripts, receipts, runtime state and installed packages
private. `usage.jsonl` contains numeric provider usage, including automatic cache
usage. No paid cache objects or explicit response cache are created. Adapter cost
estimates are not a provider billing reconciliation. Do not sum cumulative native
resume counters as if they were independent requests.

The previous isolated `codex-gemini` launcher/home is retired; do not install it.
