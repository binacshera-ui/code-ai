# code-ai

**A mobile-first control plane for serious terminal agents.**

`code-ai` brings **Codex**, **Claude Code**, and **Gemini CLI** into one polished workspace built for real execution, not toy demos. It runs your actual local CLIs, keeps their real homes, and adds the operator layer that power users always end up building for themselves: queues, scheduling, project tracking, reusable context, execution modes, browser automation, and session recovery flows.

<p align="center">
  <img src="deploy/code-ai/assets/readme/showcase-hero.png" alt="code-ai showcase" width="100%" />
</p>

<p align="center"><em>All product images below are live mobile captures taken from the running app.</em></p>

## What It Feels Like

- **One interface for three providers** with real profile homes and provider-specific controls.
- **Mobile-first session workflow** instead of a desktop-only shell wrapper.
- **Queues, recurring runs, and follow-up modes** for serious long-running work.
- **Reusable context** with files, anchors, skills, reminders, and session-scoped restrictions.
- **Real browser mode for Codex** with a live Chromium session and persisted profile.
- **Projects, topics, archives, and cross-user copy flows** for keeping large operator work organized.

## Product Tour

### Fast Entry Points

<p align="center">
  <img src="deploy/code-ai/assets/readme/showcase-quick-actions.png" alt="Quick actions" width="31%" />
  <img src="deploy/code-ai/assets/readme/showcase-attachments.png" alt="Attachments and reusable context" width="31%" />
  <img src="deploy/code-ai/assets/readme/showcase-scheduler.png" alt="Recurring and one-shot scheduling" width="31%" />
</p>

- **Quick Actions** keep the main flows one tap away: new chat, fixed instruction, file tree, and game/testing utilities.
- **Attachments** are more than uploads. You can add files, anchors, skills, reminders, and higher-level modes from one compact entry point.
- **Scheduling** handles both one-shot and recurring execution without leaving the conversation surface.

### Real Control Over Execution

<p align="center">
  <img src="deploy/code-ai/assets/readme/showcase-model-panel.png" alt="Model, permissions, and runtime panel" width="48%" />
  <img src="deploy/code-ai/assets/readme/showcase-modes.png" alt="Execution modes" width="48%" />
</p>

- **Model & thinking panel** exposes the actual runtime state: model, depth, permissions, sandbox mode, response speed, and current provider behavior.
- **Execution modes** let the same chat become:
  - a normal run,
  - a professional 3-stage flow,
  - an annotations/reporting flow,
  - an agent-session orchestration flow,
  - a real browser session,
  - or a restricted-edit session.

### Workspace Visibility

<p align="center">
  <img src="deploy/code-ai/assets/readme/showcase-file-tree.png" alt="Workspace file tree" width="48%" />
  <img src="deploy/code-ai/assets/readme/showcase-project-board.png" alt="Project board" width="48%" />
</p>

- **Workspace file tree** gives live visibility into the active directory and makes path selection practical on mobile.
- **Project board** lets you group sessions into larger efforts, track sub-goals, and keep multi-session work from dissolving into chat sprawl.

## What You Can Do With It

### Run Real Provider Workflows

- Start a Codex, Claude, or Gemini session from the same UI.
- Keep different provider homes and working directories per profile.
- Inspect what the model actually sent to tools and what tools actually returned.
- Resume, fork, archive, copy, or move sessions without losing the operator context around them.

### Work With Reusable Context Instead of Repeating Yourself

- Attach normal files from the device or workspace.
- Add **anchors** that point at important files or directories.
- Attach **skills** as reusable operational context.
- Save **reminders** from any message and re-inject them later.
- Turn on **action restriction mode** so the model is explicitly told to edit only one file or directory, while the server rejects detectable out-of-scope edits where possible.

### Use Higher-Level Execution Modes

- **Professional mode** creates a staged plan / execute / verify queue flow.
- **Annotations mode** creates the main task plus a follow-up documentation/report task.
- **Agent session mode** plans and tracks coordinated sub-agents for a larger initiative.
- **Real browser mode** attaches a real Chromium toolplane to Codex for navigation, reading, forms, screenshots, console, network, and tab work.

### Operate Like a Power User

- Queue multiple tasks instead of waiting on a single foreground run.
- Schedule single-run or recurring tasks.
- Organize sessions by **topics** and **projects**.
- Copy sessions between users.
- Wake a normal session from external systems via trigger endpoints.
- Run support-specific workflows in isolated mode when needed.

## Why It Is Different

Most wrappers around coding models stop at “send prompt, render answer”. `code-ai` goes further:

- it treats **session orchestration** as a first-class product,
- it respects the fact that different providers have different strengths and runtime behaviors,
- and it assumes the operator cares about **state**, **history**, **tools**, **artifacts**, **permissions**, and **recovery**, not just chat bubbles.

This is why the interface is built around:

- session continuity,
- queue depth,
- execution staging,
- reusable context,
- provider-aware controls,
- and real local runtime introspection.

## Technical Overview

If you only wanted the product tour, you can stop above.  
Everything below is the operator and deployment layer.

### Core Stack

- **Frontend**: React + Vite, optimized for mobile usage.
- **Backend**: Node/Express orchestration layer with provider-aware routing.
- **Providers**: Codex CLI, Claude CLI, Gemini CLI.
- **State**: local app-managed storage, session metadata, queue data, and provider homes.

### Key Runtime Concepts

#### `workspaceCwd`

The default working directory used when creating a new conversation.

#### `codexHome`

Legacy field name for the selected provider home.

Examples:

- Codex -> `.codex`
- Claude -> `.claude`
- Gemini -> `.gemini`

The field name remains `codexHome` for compatibility, but it is used across the app as the generic **provider home**.

### Bring Your Own Providers

Required base tooling:

- Node.js 20+
- npm
- Git

Optional provider CLIs:

- Codex CLI
- Claude CLI
- Gemini CLI

You can run the app with one provider or all three.

### Quick Start

#### Linux / macOS

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

#### Windows PowerShell

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

### Repo Layout

- `client/` — the mobile UI
- `server/` — provider routing, queueing, parsing, and orchestration
- `deploy/code-ai/` — installer, export flow, and deployment assets
- `scripts/` — repo-local utilities
- `ecosystem.config.cjs` — PM2 process definition

### Deployment Notes

The installer can:

- write `.env`
- write `CODEX_PROFILES_JSON`
- create app-managed storage
- install dependencies
- build client + server
- start or refresh PM2

### Read Next

- `README.he.md` — Hebrew version
- `AGENT.md` — operator / handoff notes
- `WINDOWS.FIELD-NOTES.he.md` — practical Windows notes
- `deploy/code-ai/install.mjs` — canonical installer
- `server/config.ts` — profile and storage configuration
- `client/src/components/codex/CodexMobileApp.tsx` — main UI shell
