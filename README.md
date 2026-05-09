# code-ai Deployment Kit

Hebrew version:

- `README.he.md`

This repo is meant to be easy to install on a clean machine with as little manual work as possible.

If all you want is "get code-ai running fast", use one of the copy-paste commands below. The installer writes `.env`, installs dependencies, builds the app, creates storage folders, and starts PM2 for you.

## Fastest Install

### Linux / macOS

```bash
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --codex-home /home/ubuntu/.codex \
  --workspace /srv/codex-workspace
```

### Windows PowerShell

```powershell
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  --app-name code-ai `
  --port 4000 `
  --codex-home C:\Users\Administrator\.codex `
  --workspace D:\codex-workspace
```

### Windows CMD

```cmd
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
install.cmd --app-name code-ai --port 4000 --codex-home C:\Users\Administrator\.codex --workspace D:\codex-workspace
```

## What You Need Before Running It

Required:

- Node.js 20+
- npm
- Codex CLI installed and available in `PATH`

You only need to know 2 paths:

- `codexHome`:
  the real Codex profile folder that already contains `session_index.jsonl`, `sessions/`, and usually `.codex/config.toml`
- `workspace`:
  the folder users should work from by default

Example Linux values:

- `--codex-home /home/ubuntu/.codex`
- `--workspace /srv/codex-workspace`

Example Windows values:

- `--codex-home C:\Users\Administrator\.codex`
- `--workspace D:\codex-workspace`

If `codex` is not in `PATH`, add:

- `--codex-bin /full/path/to/codex`

## What The Installer Does

The installer is `deploy/code-ai/install.mjs`. The shell and PowerShell wrappers call it for you.

It will:

- create `.env`
- write `CODEX_PROFILES_JSON`
- create storage folders for uploads, queue state, and logs
- run `npm install --include=dev`
- run `npm run build`
- start or restart the app with PM2 through `ecosystem.config.cjs`

You do not need to manually:

- create `.env`
- install PM2 globally
- create the queue or upload folders
- build the client or server by hand

## The Smallest Valid Install

If you want the fewest flags possible, this is the baseline:

```bash
./install.sh --codex-home /home/ubuntu/.codex --workspace /srv/codex-workspace
```

That will use defaults:

- app name: `code-ai-app`
- port: `4000`
- open access: `true`
- allow any paths: `true`

## Recommended Production Install

Use this when you want a cleaner final setup name and a fixed storage location:

```bash
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --codex-home /home/ubuntu/.codex \
  --workspace /srv/codex-workspace \
  --storage-root /srv/code-ai-data \
  --device-password change-me-now \
  --session-secret change-me-too
```

## Multi-Profile Install

If you want more than one Codex profile, pass `--profiles-json` and do not rely on the single-profile flags.

Linux example:

```bash
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --profiles-json '[{"id":"default","label":"Default","codexHome":"/home/ubuntu/.codex","workspaceCwd":"/srv/codex-workspace","defaultProfile":true},{"id":"ops","label":"Ops","codexHome":"/srv/codex/ops-home","workspaceCwd":"/srv/ops-workspace"}]'
```

## Verify The Install

After install, run:

```bash
npx pm2 describe code-ai
npx pm2 logs code-ai
```

Open:

- `http://SERVER_IP:4000`

What success looks like:

- the UI opens
- profiles load
- old Codex sessions appear
- sending a message creates or continues a Codex session

## The Important Runtime Files

Repo root:

- `.env`
- `ecosystem.config.cjs`
- `AGENT.md`

Storage root, by default under `CODEX_STORAGE_ROOT`:

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

Actual Codex chat history is not stored there.

Real chat history lives in each Codex profile home:

- `session_index.jsonl`
- `sessions/`
- `archived_sessions/`

## The Most Common Mistake

The app can boot correctly while the chats still look empty if you pointed `--codex-home` at the wrong place.

Before assuming the app is broken, verify that the target `codexHome` really contains:

- `session_index.jsonl`
- `sessions/`

If those files are somewhere else, reinstall with the real `--codex-home`.

## Update The App Later

If the repo already exists and you just want the latest version:

```bash
git pull
npm install --include=dev
npm run build
npx pm2 restart code-ai --update-env
```

If your PM2 app name is still the default, replace `code-ai` with `code-ai-app`.

## Useful Installer Flags

- `--app-name NAME`
- `--port PORT`
- `--codex-home PATH`
- `--workspace PATH`
- `--profile-id ID`
- `--profile-label LABEL`
- `--profiles-json JSON`
- `--storage-root PATH`
- `--public-hosts CSV`
- `--open-access true|false`
- `--allow-any-paths true|false`
- `--extra-readable-roots /srv/shared,/mnt/data`
- `--database-url postgresql://...`
- `--session-secret VALUE`
- `--cookie-domain VALUE`
- `--device-password VALUE`
- `--codex-bin PATH`
- `--skip-npm-install`
- `--skip-build`
- `--skip-pm2`

Full help:

```bash
./install.sh --help
node deploy/code-ai/install.mjs --help
```

## Reverse Proxy

The installer does not configure DNS or your web server.

Use:

- `deploy/code-ai/nginx-site.conf.template`

Point it to the port you installed on.

## Export As Standalone Repo

To generate a clean export from the source app repo:

```bash
node deploy/code-ai/export-standalone.mjs /tmp/code-ai-standalone --git-init
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\code-ai\export-standalone.ps1 C:\temp\code-ai-standalone --git-init
```

The export includes:

- `AGENT.md`
- `.env.example`
- `client/`
- `server/`
- `package.json`
- `package-lock.json`
- `vite.config.ts`
- `tsconfig.json`
- `ecosystem.config.cjs`
- `deploy/code-ai/*`
- `install.sh`, `install.ps1`, `install.cmd`
- `export-standalone.sh`, `export-standalone.ps1`, `export-standalone.cmd`

## If You Want The Least-Fragile Setup

Use this checklist:

1. Install Codex CLI first and verify `codex --help` works.
2. Verify the real Codex home path contains `sessions/`.
3. Run `./install.sh` with explicit `--codex-home` and `--workspace`.
4. Set your own `--device-password` and `--session-secret`.
5. Confirm PM2 is healthy with `npx pm2 logs <app-name>`.
6. Open the UI and confirm old chats are visible before going live.

## Runtime Model

- Default mode is open-access control surface.
- Postgres is optional.
- If `DATABASE_URL` is missing, browser sessions are in memory.
- Profiles and storage roots are fully env-driven.
- Device unlock password comes from `CODEX_DEVICE_ADMIN_PASSWORD`.
