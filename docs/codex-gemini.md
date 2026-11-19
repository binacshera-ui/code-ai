# Gemini inside the Codex harness

This optional installation runs the existing Codex binary against Gemini through
the LiteLLM Responses API. It uses its own `CODEX_HOME`, gateway credential and
session storage. The active OpenAI installation and its authentication are not
modified. Gemini CLI's `.env` remains the source of the upstream API key; the
launcher loads it directly into the gateway process, never into Codex's tools.

Install LiteLLM into a dedicated virtual environment, then provision the separate
home (all paths below are operator choices, not repository requirements):

```bash
uv venv --python python3 /home/example/.local/share/code-ai/codex-gemini/venv
uv pip install --python /home/example/.local/share/code-ai/codex-gemini/venv/bin/python 'litellm[proxy]==1.110.1'
node deploy/code-ai/codex-gemini/setup.mjs \
  --runtime-root /home/example/.local/share/code-ai/codex-gemini \
  --source-home /home/example/.codex \
  --key-file /home/example/.gemini/.env \
  --codex-bin /usr/local/bin/codex
node deploy/code-ai/codex-gemini/run.mjs --gateway-only
node deploy/code-ai/codex-gemini/run.mjs --status
node deploy/code-ai/codex-gemini/run.mjs -C /path/to/workspace
node deploy/code-ai/codex-gemini/run.mjs exec --json -C /path/to/workspace 'Your task'
node deploy/code-ai/codex-gemini/run.mjs exec resume SESSION_ID 'Continue'
node deploy/code-ai/codex-gemini/verify.mjs
node deploy/code-ai/codex-gemini/verify-app-server.mjs /absolute/path/to/pilot-receipt.json
```

The gateway listens on loopback only and requires a generated local key. It has
one explicit model route and no provider fallback. Codex executes the tools,
stores sessions and manages context. LiteLLM translates model requests, responses
and custom tool calls; it does not own the agent loop. Paid cache creation and
gateway response caching are disabled. Provider-reported automatic cache usage
must be verified on representative turns.

The isolated profile uses native workspace-write permissions and approvals.
The model catalog reuses the installed Codex instructions and defines Gemini's
context limit and reasoning levels. OpenAI-hosted web search is disabled; expose
browser or search capabilities through ordinary authorized MCP tools if needed.
Existing session-specific browser bindings are not copied into this installation.

Runtime state, logs, credentials, verification transcripts and installed packages
must remain outside source control. Qualification must include streamed text,
shell and patch tools, MCP tools, follow-ups, process restart/resume, cancellation,
native compaction and provider usage. A model-list response alone is insufficient.

The operator can put an executable symlink to `deploy/code-ai/codex-gemini/run.mjs` on PATH
as `codex-gemini`. That launcher starts only the isolated gateway when needed and
passes all ordinary Codex CLI or app-server arguments to the existing binary.
`codex-gemini --status` also compares the original Codex configuration and
authentication hashes with the setup baseline. This optional installation does
not register a profile in the production Code AI web application.
The private installation record under the user's XDG configuration directory
locates the runtime; `CODE_AI_GEMINI_RUNTIME` can select another isolated runtime.

Only the OpenAI-specific `prompt_cache_key` parameter is explicitly removed by
the adapter. Other unsupported parameters fail visibly. Gemini's automatic
prompt caching remains enabled; no explicit cache objects are created. Numeric
usage is written by `usage_callback.py` to private `evidence/usage.jsonl`, including
provider-reported cached input. Gateway cost fields are estimates from LiteLLM's
price catalog, not a provider billing reconciliation. Codex resume can report
cumulative usage; use the per-request gateway records rather than adding those
cumulative totals.
