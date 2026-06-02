# code-ai

`code-ai` is a mobile-first workspace for running and coordinating the leading terminal coding agents from one interface:

- Codex
- Claude Code
- Gemini CLI

It is designed for operators who want one clean control plane for conversations, queueing, scheduling, topic grouping, project memory, cross-user transfer, support flows, and provider-specific execution settings without giving up local CLI power.

## Product Preview

<p align="center">
  <img src="deploy/code-ai/assets/readme/topic-management.png" alt="Topic management" width="24%" />
  <img src="deploy/code-ai/assets/readme/history-panel.png" alt="Session history" width="24%" />
  <img src="deploy/code-ai/assets/readme/quick-actions.png" alt="Quick actions" width="24%" />
  <img src="deploy/code-ai/assets/readme/model-panel.png" alt="Model and permissions panel" width="24%" />
</p>

## What Makes It Different

- One UI for three providers, with real local profile homes per provider.
- Mobile-first session workflow instead of a desktop-only wrapper.
- Built-in queueing and scheduling, including deferred and recurring execution.
- Topic grouping, project boards, reminders, anchors, skills, and reusable context tools.
- Cross-provider transfers and cross-user session copy flows.
- Internal support mode with isolated storage and sandbox rules.
- Trigger endpoints that can wake a normal session from an external system event.

## Core Experience

`code-ai` gives you a single workspace for:

- starting regular chats
- forking or transferring sessions
- attaching files, anchors, skills, reminders, and agent modes
- scheduling one-shot or recurring runs
- tracking session-local subtasks and project assignments
- inspecting changed files, tool traces, queue state, context usage, permissions, and rate limits

The app uses your real CLI installations and their real homes. It does not fake a provider layer on top of hosted APIs.

## Bring Your Own Providers

You can run the app with one provider or with all three.

Required base tooling:

- Node.js 20+
- npm
- Git

Optional provider CLIs:

- Codex CLI
- Claude CLI
- Gemini CLI

The full multi-provider experience is available when all three are installed and authenticated on the host.

## Quick Start

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

## Repo Layout

- `client/` — the mobile UI
- `server/` — provider routing, queueing, parsing, and orchestration
- `deploy/code-ai/` — installer, export flow, and deployment assets
- `scripts/` — repo-local utilities
- `ecosystem.config.cjs` — PM2 process definition

## Important Runtime Concepts

### `workspaceCwd`

The default working directory used for new conversations.

### `codexHome`

Legacy field name for the provider home of the selected profile.

Examples:

- Codex -> `.codex`
- Claude -> `.claude`
- Gemini -> `.gemini`

The name stays `codexHome` for backward compatibility with existing installs and stored metadata, but it now means “provider home” across the whole app.

## Where To Read Next

- `README.he.md` — Hebrew version
- `AGENT.md` — operator / handoff notes
- `WINDOWS.FIELD-NOTES.he.md` — practical Windows install notes
- `deploy/code-ai/install.mjs` — canonical installer
- `server/config.ts` — profile and storage configuration
- `client/src/components/codex/CodexMobileApp.tsx` — main UI shell

## Deployment Notes

The repo ships with a one-command installer that:

- writes `.env`
- writes `CODEX_PROFILES_JSON`
- creates app-managed storage
- installs dependencies
- builds client + server
- starts or refreshes PM2

If you are looking for operational details, use:

- `deploy/code-ai/install.mjs`
- `ecosystem.config.cjs`
- `AGENT.md`
