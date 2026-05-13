# AGENT.md

Hebrew version:

- `AGENT.he.md`

This file is the operator handoff for `code-ai`.

`code-ai` is a shared mobile workspace for 3 provider CLIs:

- Codex
- Claude Code
- Gemini CLI

It also includes an isolated internal `Support workspace` mode for human-like support operations.

Use this file when you need to install, update, debug, recover data, or explain the system to another agent or operator.

## Read These First

If you only have a minute, read:

1. `README.md`
2. `deploy/code-ai/install.mjs`
3. `server/config.ts`
4. `server/agentService.ts`
5. `client/src/components/codex/CodexMobileApp.tsx`

## What This Repo Actually Is

- A mobile-first multi-provider coding workspace
- Frontend + backend
- Shared queue, scheduling, uploads, titles, topics, hidden/archive state
- Cross-provider transfers between Codex, Claude, and Gemini
- Provider-specific session parsing from each CLI's real local storage

## The Naming Rule You Must Understand

Many internal names still say `codex`:

- `/api/codex/*`
- `CODEX_PROFILES_JSON`
- `server/codexRoutes.ts`
- `server/codexQueue.ts`
- `server/codexService.ts`
- `client/src/components/codex/...`

Those names are legacy compatibility names.

In the current product, they are part of `code-ai`, not proof that the system is Codex-only.

## Core Runtime Files

The real logic is split like this:

- `server/config.ts`
  app config, profile config, paths, storage roots
- `server/agentService.ts`
  provider router used by the rest of the system
- `server/codexService.ts`
  Codex session parsing + execution
- `server/claudeService.ts`
  Claude session parsing + execution
- `server/geminiService.ts`
  Gemini session parsing + execution
- `server/codexQueue.ts`
  shared queue, scheduling, retries, run orchestration
- `server/codexForkSessions.ts`
  draft sessions, fork metadata, transfer metadata
- `server/codexRoutes.ts`
  HTTP API used by the mobile client
- `client/src/components/codex/CodexMobileApp.tsx`
  main UI shell

## The Fastest Safe Install

### Linux / macOS

```bash
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --profiles-json '[{"id":"codex-main","label":"Codex","provider":"codex","codexHome":"/home/ubuntu/.codex","workspaceCwd":"/srv/workspace","defaultProfile":true},{"id":"claude-main","label":"Claude","provider":"claude","codexHome":"/home/ubuntu/.claude","workspaceCwd":"/srv/workspace"},{"id":"gemini-main","label":"Gemini","provider":"gemini","codexHome":"/home/ubuntu/.gemini","workspaceCwd":"/srv/workspace"}]' \
  --device-password change-me-now \
  --session-secret change-me-too
```

### Windows PowerShell

```powershell
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  --app-name code-ai `
  --port 4000 `
  --profiles-json '[{"id":"codex-main","label":"Codex","provider":"codex","codexHome":"C:\\Users\\Administrator\\.codex","workspaceCwd":"D:\\workspace","defaultProfile":true},{"id":"claude-main","label":"Claude","provider":"claude","codexHome":"C:\\Users\\Administrator\\.claude","workspaceCwd":"D:\\workspace"},{"id":"gemini-main","label":"Gemini","provider":"gemini","codexHome":"C:\\Users\\Administrator\\.gemini","workspaceCwd":"D:\\workspace"}]' `
  --device-password change-me-now `
  --session-secret change-me-too
```

## What Must Exist On The Host

Base:

- Node.js 20+
- npm
- Git

Provider binaries:

- `codex` for Codex
- `claude` for Claude
- `gemini` for Gemini

Optional explicit binary envs:

- `CODEX_BIN`
- `CLAUDE_BIN`
- `GEMINI_BIN`

Provider homes:

- Codex -> real `.codex`
- Claude -> real `.claude`
- Gemini -> real `.gemini`

Important:

- The field name in profile JSON is still `codexHome`.
- In `code-ai`, that field means "provider home", not "Codex only".

## The 2 Path Concepts That Break Installs

### `workspaceCwd`

Default working directory used by new chats.

### `codexHome`

Legacy field name for provider data home.

Examples:

- Codex: `/home/ubuntu/.codex`
- Claude: `/home/ubuntu/.claude`
- Gemini: `/home/ubuntu/.gemini`

If users say "my old chats are missing", verify this first.

## Repo Layout

- `client/` — Vite app and UI
- `server/` — API + orchestration
- `deploy/code-ai/` — install/export/nginx assets
- `ecosystem.config.cjs` — PM2 config
- `.env.example` — environment reference

## App-managed Storage

Defaults come from `CODEX_STORAGE_ROOT`.

Expected files:

- `uploads/`
- `queue/state.json`
- `queue/fork-sessions.json`
- `session-titles.json`
- `session-topics.json`
- `session-visibility.json`
- `session-instructions.json`
- `logs/client-crashes.jsonl`
- `logs/server-crashes.jsonl`
- `logs/file-access.jsonl`
- `support/support-session-state.json`
- `support/homes/<provider>/<source-profile>/...`
- `support/sandbox/<provider>/<source-profile>/...`

## Where Real Sessions Live

Not in `.code-ai`.

Check the selected provider home.

Codex:

- `session_index.jsonl`
- `sessions/`
- `archived_sessions/`

Claude:

- `projects/<workspace>/*.jsonl`
- `projects/<workspace>/memory/`
- `projects/<workspace>/<session>/subagents/`

Gemini:

- `projects.json`
- `tmp/<project-id>/chats/*.jsonl`

## Support Workspace Internals

Support mode derives extra profiles named:

- `support-<standard-profile-id>`

Those profiles:

- use isolated provider homes under `.code-ai/support/homes/...`
- keep support request metadata in `.code-ai/support/support-session-state.json`
- expose dedicated entrypoints:
  - `POST /api/codex/support/ask`
  - `POST /api/codex/support/webhook`
- inject a fixed support envelope before provider execution

Primary files:

- `server/supportAgentService.ts`
- `server/agentService.ts`
- `server/codexRoutes.ts`
- `client/src/components/codex/CodexMobileApp.tsx`

## First Place To Inspect For Each Symptom

### "Old chats are missing"

Check:

- `.env`
- `CODEX_PROFILES_JSON`
- active provider profile home
- provider session files in that home
- `session-visibility.json`

### "Scheduled task disappeared"

Check:

- `CODEX_QUEUE_ROOT/state.json`
- `server/codexQueue.ts`
- PM2 logs

### "Transfer between providers looks wrong"

Check:

- `server/codexForkSessions.ts`
- `server/codexQueue.ts`
- `server/agentService.ts`
- provider-specific service of the target provider

### "Uploads vanished"

Check:

- `CODEX_UPLOAD_ROOT`
- `/api/codex/uploads`
- `logs/file-access.jsonl`

### "UI opens but nothing works"

Check:

- `.env`
- `CODEX_PROFILES_JSON`
- provider binaries on PATH
- `npx pm2 logs <app-name>`

## Commands Operators Actually Need

```bash
./install.sh --help
./export-standalone.sh --help
npm install --include=dev
npm run build
npx pm2 describe code-ai
npx pm2 logs code-ai
npx pm2 restart code-ai --update-env
```

Useful direct entrypoints:

```bash
node deploy/code-ai/install.mjs --help
node deploy/code-ai/export-standalone.mjs --help
```

## Update Workflow

```bash
git pull
npm install --include=dev
npm run build
npx pm2 restart code-ai --update-env
```

If PM2 still uses the default name, use `code-ai-app`.

## Export Workflow

```bash
npm run export:standalone
```

Or directly:

```bash
node deploy/code-ai/export-standalone.mjs /tmp/code-ai-standalone --git-init
```

That export intentionally keeps:

- `README.md`
- `README.he.md`
- `AGENT.md`
- `AGENT.he.md`
- `.env.example`
- `install.*`
- `export-standalone.*`

Do not delete them.

## Environment Variables That Matter Most

- `PORT`
- `PM2_APP_NAME`
- `CODEX_BIN`
- `CLAUDE_BIN`
- `GEMINI_BIN`
- `CODEX_PROFILES_JSON`
- `CODEX_STORAGE_ROOT`
- `CODEX_UPLOAD_ROOT`
- `CODEX_QUEUE_ROOT`
- `CODEX_LOG_ROOT`
- `CODEX_DEVICE_ADMIN_PASSWORD`
- `CODEX_ALLOW_ANY_PATHS`
- `CODEX_ALLOWED_FILE_ROOTS`
- `SESSION_SECRET`
- `SESSION_COOKIE_DOMAIN`
- `DATABASE_URL`

## What Not To Waste Time On

- Editing `dist/` manually
- Looking for transcript history under `.code-ai/`
- Assuming `CODEX_STORAGE_ROOT` is the real chat history
- Debugging DNS/nginx from inside this repo before basic local validation

## Minimum Broken-Install Checklist

1. Open `.env`.
2. Verify `CODEX_PROFILES_JSON` paths are real and readable.
3. Verify storage roots are writable.
4. Verify the relevant provider binary works:
   - `codex --help`
   - `claude --help`
   - `gemini --help`
5. Run `npm run build`.
6. Run `npx pm2 describe <app-name>`.
7. Run `npx pm2 logs <app-name>`.
8. If sessions are missing, inspect the provider home directly.
