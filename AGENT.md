# AGENT.md

Hebrew version:

- `AGENT.he.md`

This is the standalone code-ai repository. This file is the source-of-truth handoff for human or AI operators who need to install it, update it, debug it, or recover data.

If you are in a hurry, read only:

1. `README.md`
2. `deploy/code-ai/install.mjs`
3. `server/config.ts`
4. `server/codexService.ts`

## What This Repo Is

- Mobile-first Codex control surface.
- Frontend + backend for browsing Codex sessions and sending work to the Codex CLI.
- Supports multiple profiles, queueing, scheduling, uploads, per-session instructions, session titles, topics, visibility, and file preview.

## The Fastest Safe Install

### Linux / macOS

```bash
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --codex-home /home/ubuntu/.codex \
  --workspace /srv/codex-workspace \
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
  --codex-home C:\Users\Administrator\.codex `
  --workspace D:\codex-workspace `
  --device-password change-me-now `
  --session-secret change-me-too
```

What this does:

- writes `.env`
- installs dependencies
- builds client and server
- creates storage folders
- starts or restarts PM2

## The 2 Paths You Must Get Right

Every broken install usually comes from one of these:

- `codexHome`
- `workspace`

### `codexHome`

This is the real Codex data home for a profile.

It should contain:

- `session_index.jsonl`
- `sessions/`
- sometimes `archived_sessions/`
- usually `config.toml`

If users say "my old chats are missing", the first thing to verify is that `--codex-home` points to the right place.

### `workspace`

This is the default working directory shown in the mobile UI and used for new conversations unless the user changes it.

## First Files To Read

- `README.md` — installation and update instructions
- `deploy/code-ai/install.mjs` — canonical installer and `.env` writer
- `server/config.ts` — how env vars become real paths and runtime config
- `server/index.ts` — Express boot, session store, queue startup
- `server/codexRoutes.ts` — HTTP API surface
- `server/codexService.ts` — Codex session parsing and CLI execution
- `server/codexQueue.ts` — queue persistence and worker behavior
- `client/src/components/codex/CodexMobileApp.tsx` — main mobile UI

## Repo Layout

- `client/` — Vite client and mobile UI
- `server/` — Express server and Codex orchestration
- `deploy/code-ai/` — installer, exporter, nginx template
- `ecosystem.config.cjs` — PM2 process definition
- `.env.example` — reference env template

## Runtime Layout

### Repo Root

Important files:

- `.env`
- `package.json`
- `ecosystem.config.cjs`
- `AGENT.md`

### App-managed storage

Defaults live under `CODEX_STORAGE_ROOT`:

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

### Real Codex chat history

Actual chat transcripts are not stored in `CODEX_STORAGE_ROOT`.

They live in each profile's `codexHome`:

- `session_index.jsonl`
- `sessions/`
- `archived_sessions/`

When a user asks:

- "where are the chats"
- "why is this old conversation missing"
- "why do I see no history"

check the selected profile's `codexHome` first.

## The Exact Symptoms -> First Place To Inspect

### "Old chats are missing"

Check:

- `.env`
- `CODEX_PROFILES_JSON`
- active profile `codexHome`
- `codexHome/session_index.jsonl`
- `codexHome/sessions/`
- `session-visibility.json`

### "Scheduled task disappeared"

Check:

- `CODEX_QUEUE_ROOT/state.json`
- `server/codexQueue.ts`
- PM2 logs

### "Uploaded file is gone"

Check:

- `CODEX_UPLOAD_ROOT`
- `/api/codex/uploads`
- `logs/file-access.jsonl`

### "Custom title / topic / hidden state vanished"

Check:

- `session-titles.json`
- `session-topics.json`
- `session-visibility.json`

### "Session instruction vanished"

Check:

- `session-instructions.json`

### "UI opens but nothing works"

Check:

- `npx pm2 logs <app-name>`
- `.env`
- `CODEX_BIN`
- `CODEX_PROFILES_JSON`
- whether `codex --help` works on that host

## Install, Build, Run

### Fresh install

```bash
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --codex-home /home/ubuntu/.codex \
  --workspace /srv/codex-workspace
```

### Manual developer install

```bash
npm install --include=dev
npm run build
node deploy/code-ai/install.mjs --skip-npm-install --skip-build --skip-pm2
```

### Restart after code changes

```bash
npm run build
npx pm2 restart code-ai --update-env
```

If the PM2 app still uses the default name, use `code-ai-app` instead.

## Commands Agents Will Actually Need

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

If the repo is already installed and you want the latest code:

```bash
git pull
npm install --include=dev
npm run build
npx pm2 restart code-ai --update-env
```

## Export Workflow

From the source app repo:

```bash
npm run export:standalone
```

Or directly:

```bash
node deploy/code-ai/export-standalone.mjs /tmp/code-ai-standalone --git-init
```

That export intentionally includes handoff files:

- `README.md`
- `AGENT.md`
- `.env.example`
- `install.*`
- `export-standalone.*`

Those files are not noise. Keep them.

## Environment Variables That Matter Most

- `PORT`
- `PM2_APP_NAME`
- `CODEX_BIN`
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

- Editing `dist/` directly
- Looking for transcript history under `.code-ai/`
- Treating `CODEX_STORAGE_ROOT` as the real chat history location
- Debugging reverse proxy or DNS from inside this repo

## If You Need To Debug A Broken Install

1. Open `.env`.
2. Verify `CODEX_PROFILES_JSON` paths are real and readable on the target machine.
3. Verify `CODEX_STORAGE_ROOT`, `CODEX_UPLOAD_ROOT`, `CODEX_QUEUE_ROOT`, and `CODEX_LOG_ROOT` exist and are writable.
4. Run `codex --help` or verify the path from `CODEX_BIN`.
5. Run `npm run build`.
6. Run `npx pm2 describe <app-name>`.
7. Run `npx pm2 logs <app-name>`.
8. If sessions are missing, inspect `codexHome/session_index.jsonl` and `codexHome/sessions/`.

## If You Need The Least-Fragile Production Shape

- explicit `--app-name`
- explicit `--storage-root`
- explicit `--device-password`
- explicit `--session-secret`
- explicit `--codex-home`
- explicit `--workspace`

That removes almost all ambiguity from later support and recovery work.
