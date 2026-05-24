---
name: bina-cshera-session-trigger-integrator
description: Use when wiring any Bina Cshera service, worker, cron, queue, poller, or failure path to wake a regular code-ai session through the external session-trigger endpoint. Use for requests about "טריגר", webhook into an existing session, alert-to-session routing, where to configure a trigger URL, which file to change in a service, or how to validate that a service can inject a task into a normal Codex/Claude/Gemini session.
---

# Bina Cshera Session Trigger Integrator

Use this skill when another agent must figure out how to connect a Bina Cshera service to a normal `code-ai` session trigger.

This skill assumes the current workspace is the **full `bina-cshera` monorepo**, not only the standalone `code-ai` export.

This skill is specifically for **regular sessions** in `code-ai`, not:

- support-mode webhooks
- agent-session planners
- ad-hoc one-off queue items without a persistent target session

## Quick Start

1. Read [references/code-ai-trigger-contract.md](references/code-ai-trigger-contract.md).
2. Read [references/bina-cshera-trigger-map.md](references/bina-cshera-trigger-map.md).
3. Inspect the target service's real entrypoint and config file before proposing any change.

## What The Skill Must Help Another Agent Decide

For every trigger task, answer these questions in order:

1. Which **existing code-ai session** should wake up?
2. Is this a **regular session trigger** or actually a **support webhook**?
3. Which service owns the event:
   - inbound webhook service
   - async worker
   - queue consumer
   - poller
   - failure handler
   - proxy/gateway
4. Where should the trigger URL be configured:
   - env file
   - Secret Manager / secret file
   - runtime config module
   - PM2 / ecosystem
5. Which file should emit the POST:
   - request handler
   - job completion block
   - catch block
   - status callback
   - health/error observer
6. What payload should be sent so the resumed session can act immediately?

## Trigger Contract Rules

Always treat the session trigger URL as a **full signed URL** that already contains the token:

- preferred storage: one env/secret value containing the full URL
- do not split the token into multiple config fields unless the target service already requires that pattern
- do not hardcode the trigger URL in source code

The normal fire path is:

- `POST /api/codex/session-triggers/:triggerId/fire?token=...`

The payload should stay small and structured:

```json
{
  "prompt": "בדוק עכשיו את שגיאת MAKE2 והחזר סיכום פעולה ברור.",
  "source": "typing-gateway",
  "payload": {
    "service": "typing-gateway",
    "event": "pipeline_failed",
    "workId": "abc123",
    "error": "timeout",
    "status": "failed"
  }
}
```

Prefer:

- `prompt`: short actionable task
- `source`: emitting service name
- `payload`: machine-readable facts

Do not dump huge logs into the trigger payload unless the session really needs them.

## Workflow

### 1. Identify The Emitter

Classify the target service into one of these patterns:

- **direct webhook / request handler**
- **async queue worker**
- **status poller**
- **final callback sender**
- **failure handler**
- **proxy / infra observer**

Then pick the earliest reliable place where the event becomes final enough to wake the session.

### 2. Find The Configuration Surface

Before coding, locate:

- env loader
- config module
- deployment/env source
- existing webhook or callback URL fields

Prefer adding a service-specific config key near existing callbacks rather than inventing a second config style.

### 3. Reuse Existing Outbound Hooks First

If the service already sends:

- final webhooks
- status callbacks
- approval webhooks
- failure notifications

prefer extending that path before inventing a new transport layer.

### 4. Emit A Regular Session Trigger, Not Support Mode

Use the regular session trigger when:

- the target is an existing normal chat session
- the user wants the same session to continue with new context
- the result should appear as a normal queued task inside that session

Use support mode only when the workflow is intentionally isolated into support homes and support envelopes.

### 5. Validate End-To-End

Validation order:

1. Create a real trigger in `code-ai` UI for the target session.
2. Store the full trigger URL in the service config.
3. Send a manual `curl` or local POST from the service environment.
4. Verify:
   - queue item created
   - queue item completed
   - message appended into the intended session
5. Only then wire the live event path.

## Mandatory Output When Another Agent Uses This Skill

When asked to wire a service trigger, produce:

1. `target session` and why it is the correct one
2. `emitter file(s)` that should be changed
3. `config file(s)` or secret source that must hold the trigger URL
4. the exact JSON payload shape
5. the exact validation plan
6. whether this should be:
   - immediate trigger
   - delayed/polled trigger
   - completion-only trigger
   - failure-only trigger

## High-Value Service Families

Start with the mapped families in [references/bina-cshera-trigger-map.md](references/bina-cshera-trigger-map.md):

- `MAKE2`
- `typing-gateway`
- `gemini-conversation-service`
- `status-polling-service`
- `services-gateway`
- `nexus-flow-dashboard`

If the target service is not listed, use the search patterns in the reference and map:

- entrypoint
- callback path
- config surface
- failure path

## Safety Rules

- Never store secrets or trigger URLs in committed source if the service already uses `.env`, secret files, or Secret Manager.
- Never confuse a trigger that wakes a regular session with a support webhook that creates an isolated support run.
- Do not choose a hook point that can fire many times per second unless you also define de-duplication or throttling.
- If the service already has idempotency or callback guards, integrate there instead of bypassing them.

## Useful Search Patterns

For unmapped services, start with:

```bash
rg -n "webhook|callback|status|health|error|queue|notify|alert|cron|poll" <service-dir>
```

Then find the config surface:

```bash
rg -n "process\\.env|dotenv|Secret|config|ecosystem|CLOUD_RUN|SERVICE_" <service-dir>
```

## Companion Skills

Use `bina-cshera-2-0` if the routing or service ownership is ambiguous.

Use `bitzua-top` if the user gives only a terse service nickname and expects you to infer the real repo.
