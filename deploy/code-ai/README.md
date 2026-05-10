# code-ai Deployment Kit

Hebrew version:

- `README.he.md`

`code-ai` is a mobile-first workspace for operating the 3 leading terminal coding agents from one UI:

- Codex
- Claude Code
- Gemini CLI

This repo is not "a Codex skin" anymore. It is a unified control plane for multiple provider CLIs, shared sessions UI, queueing, scheduling, uploads, transfers between providers, and provider-specific profile homes.

## What Must Be Installed

Base requirements:

- Node.js 20+
- npm
- Git

Provider CLIs:

- Codex CLI, if you want Codex sessions and execution
- Claude CLI, if you want Claude sessions and execution
- Gemini CLI, if you want Gemini sessions and execution

Authentication / provider state:

- Codex profiles must have a real `.codex` home
- Claude profiles must have a real `.claude` home
- Gemini profiles must have a real `.gemini` home

Important:

- You can run `code-ai` with only one provider installed.
- You get the full multi-provider experience only when all 3 CLIs are installed and authenticated on the host.

## The Fastest Install

If you only want the app running fast, install with explicit profiles JSON from day one.

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

### Windows CMD

```cmd
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
install.cmd --app-name code-ai --port 4000 --profiles-json "[{\"id\":\"codex-main\",\"label\":\"Codex\",\"provider\":\"codex\",\"codexHome\":\"C:\\Users\\Administrator\\.codex\",\"workspaceCwd\":\"D:\\workspace\",\"defaultProfile\":true},{\"id\":\"claude-main\",\"label\":\"Claude\",\"provider\":\"claude\",\"codexHome\":\"C:\\Users\\Administrator\\.claude\",\"workspaceCwd\":\"D:\\workspace\"},{\"id\":\"gemini-main\",\"label\":\"Gemini\",\"provider\":\"gemini\",\"codexHome\":\"C:\\Users\\Administrator\\.gemini\",\"workspaceCwd\":\"D:\\workspace\"}]" --device-password change-me-now --session-secret change-me-too
```

## What The Installer Actually Does

Canonical installer:

- `deploy/code-ai/install.mjs`

Wrappers:

- `install.sh`
- `install.ps1`
- `install.cmd`

The installer will:

- write `.env`
- write `CODEX_PROFILES_JSON`
- create app-managed storage folders
- run `npm install --include=dev`
- run `npm run build`
- start or restart PM2 through `ecosystem.config.cjs`

You do not need to manually:

- create `.env`
- install PM2 globally
- create queue/upload/log folders
- build client and server separately

## The 2 Path Concepts You Must Understand

### `workspaceCwd`

This is the default working directory shown in the UI for new conversations.

### `codexHome`

The field name is legacy, but in `code-ai` it means:

- provider data home for that profile

Examples:

- Codex profile -> `/home/ubuntu/.codex`
- Claude profile -> `/home/ubuntu/.claude`
- Gemini profile -> `/home/ubuntu/.gemini`

The field was intentionally not renamed in env / storage / JSON schema to avoid breaking old installs and old queue/session metadata.

## Provider Binary Settings

If binaries are already in `PATH`, you usually do not need these.

- `CODEX_BIN`
- `CLAUDE_BIN`
- `GEMINI_BIN`

Examples:

- `CODEX_BIN=/usr/local/bin/codex`
- `CLAUDE_BIN=/usr/local/bin/claude`
- `GEMINI_BIN=/home/ubuntu/.local/bin/gemini`

## Repo Structure

- `client/` — Vite mobile UI
- `server/` — API, parsing, queue, orchestration
- `deploy/code-ai/` — installer, exporter, nginx template
- `ecosystem.config.cjs` — PM2 definition
- `.env.example` — reference env shape

## The Main Logic Files

These are the files that define the real behavior of `code-ai`:

- `server/config.ts`
  provider/profile runtime config, paths, storage roots
- `server/agentService.ts`
  top-level provider router for Codex / Claude / Gemini
- `server/codexService.ts`
  Codex-specific session parsing and execution
- `server/claudeService.ts`
  Claude-specific session parsing and execution
- `server/geminiService.ts`
  Gemini-specific session parsing and execution
- `server/codexQueue.ts`
  shared queue, worker, scheduling, retries, fork/transfer execution
- `server/codexForkSessions.ts`
  draft fork sessions and cross-provider transfer metadata
- `server/codexRoutes.ts`
  HTTP surface used by the client
- `client/src/components/codex/CodexMobileApp.tsx`
  main application UI

## Why So Many Files Still Say "codex"

For backward compatibility.

Examples:

- `/api/codex/*`
- `CODEX_PROFILES_JSON`
- `server/codexRoutes.ts`
- `server/codexQueue.ts`
- `server/codexService.ts`
- `client/src/components/codex/...`

In the current system, those names no longer mean "Codex only". They are historical integration names inside `code-ai`.

## What Lives In App Storage

Default root:

- `CODEX_STORAGE_ROOT`

Typical contents:

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

## Where Real Sessions Live

Not in `.code-ai`.

Provider transcript/history locations come from each profile home.

Codex:

- `session_index.jsonl`
- `sessions/`
- `archived_sessions/`

Claude:

- `projects/<workspace-hash-or-name>/*.jsonl`
- `projects/<workspace>/memory/`
- `projects/<workspace>/<session>/subagents/`

Gemini:

- `projects.json`
- `tmp/<project-id>/chats/*.jsonl`

If a user says "my old chats are missing", inspect the selected provider home first, not the app storage root.

## Verify The Install

After install, run:

```bash
npx pm2 describe code-ai
npx pm2 logs code-ai
```

Then open:

- `http://SERVER_IP:4000`

Success looks like:

- the UI opens
- provider switcher appears
- profiles load
- old sessions appear for installed providers
- sending a message creates or resumes a real provider session
- transfers between providers create draft handoffs and continue naturally

## Update Workflow

```bash
git pull
npm install --include=dev
npm run build
npx pm2 restart code-ai --update-env
```

If your PM2 app still uses the installer default, replace `code-ai` with `code-ai-app`.

## Export As Standalone Repo

```bash
node deploy/code-ai/export-standalone.mjs /tmp/code-ai-standalone --git-init
```

That export intentionally includes:

- `README.md`
- `README.he.md`
- `AGENT.md`
- `AGENT.he.md`
- `.env.example`
- `client/`
- `server/`
- `deploy/code-ai/*`
- `install.*`
- `export-standalone.*`

Keep those files. They are part of the deployment handoff, not noise.

## Minimal Troubleshooting Checklist

1. Verify the wanted provider CLI exists:
   - `codex --help`
   - `claude --help`
   - `gemini --help`
2. Verify the provider homes in `CODEX_PROFILES_JSON` are real and readable.
3. Verify storage roots are writable.
4. Run `npm run build`.
5. Check `npx pm2 logs <app-name>`.
6. If sessions are missing, inspect the provider-specific home, not `.code-ai`.
