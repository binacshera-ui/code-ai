# Bina Cshera Trigger Map

This reference helps another agent identify where to wire a regular `code-ai` session trigger in the main Bina Cshera services.

## Core Distinction

Choose **regular session trigger** when:

- the destination is an existing normal chat session in `code-ai`
- the new event should appear as another task in that same session

Choose **support webhook** when:

- the run must stay isolated in support homes/state
- the event belongs to support automation rather than a normal session

## Service Map

### 1. MAKE2 unified

Primary files:

- `MAKE2/unified/core/bakar/main.js`
- `MAKE2/unified/core/bakar/handlers/*.js`
- `MAKE2/runtime/internal-broker.js`
- `MAKE2/unified/core/failure-handler/*`
- `MAKE2/load-existing-env.js`
- `MAKE2/scripts/smoke-health.js`

Good trigger points:

- route/branch failure handling
- post-routing critical exceptions
- explicit failure-handler outputs
- async callback completion points

Configuration surfaces:

- `MAKE2/load-existing-env.js`
- env files under `.secrets/env/`
- PM2/docker env sources that already hold service URLs

Recommendation:

- Add a dedicated env key per triggering context, for example:
  - `SERVICE_CODE_AI_SESSION_TRIGGER_URL`
  - or a branch-specific variant if only one branch should emit

### 2. typing-gateway

Primary files:

- `typing-gateway/config.js`
- `typing-gateway/services.js`
- `typing-gateway/main.js`

Existing outbound hooks:

- `FINAL_AGENT_WEBHOOK`
- `status_callback_url`
- `/jobs/:jobId/status`
- insufficient-balance notice flow

Good trigger points:

- pipeline start failure
- kraken dispatch failure
- final delivery failure
- status callback transitions to failed/blocked

Best configuration surface:

- `typing-gateway/config.js`
- backing env vars for service URLs

Recommendation:

- Reuse the same pattern as `FINAL_AGENT_WEBHOOK`
- Store a full `CODE_AI_SESSION_TRIGGER_URL`

### 3. gemini-conversation-service

Primary files:

- `gemini-conversation-service/index.js`
- `gemini-conversation-service/flow.md`

Existing async pattern:

- `POST /chat`
- `POST /process`
- jobs in Cloud Tasks
- optional webhook after async completion

Good trigger points:

- job completion webhook
- provider-failure catch blocks
- explicit escalation paths for repeated retries

Configuration surface:

- env vars in the service runtime

Recommendation:

- If the event already emerges from async job execution, emit the trigger from the worker completion/failure path, not the ingress route.

### 4. status-polling-service

Primary files:

- `status-polling-service/main.js`

Important fact:

- this service already posts arbitrary `webhookUrl` payloads after approval/status conditions

This is often the easiest integration:

- no extra service-specific code may be needed
- just point `webhook_url` at the signed `code-ai` session-trigger URL

Good use cases:

- wait for remote approval
- wake the session only when the remote state changes

### 5. services-gateway

Primary files:

- `services-gateway/index.js`
- `services-gateway/ecosystem.config.js`
- `services-gateway/flow.md`

Good trigger points:

- repeated proxy failures
- exact upstream 502/503 failure conditions
- health degradation detectors around `_health`

Caution:

- this layer is high-volume
- only emit triggers for important, deduplicated events
- do not wake a session on every single transient proxy error

### 6. nexus-flow-dashboard

Primary files:

- `nexus-flow-dashboard/flow.md`
- `nexus-flow-dashboard/backend/routes/webhookStore.js`
- `nexus-flow-dashboard/backend/routes/systemFlow.js`

Best use:

- observability and replay context
- not usually the first emitter

Recommendation:

- use Nexus to understand or replay the source event
- usually wire the trigger in the underlying runtime service, not in the dashboard

## Search Strategy For Unmapped Services

If the service is not listed, search in this order:

```bash
rg -n "webhook|callback|status|health|error|queue|notify|alert|cron|poll" <service-dir>
rg -n "process\\.env|dotenv|Secret|config|ecosystem|SERVICE_" <service-dir>
```

Then identify:

1. request entrypoint
2. async worker entrypoint
3. failure catch block
4. existing callback/webhook transport
5. env/config owner

## What Another Agent Must Return

For each requested integration, the agent should provide:

- exact emitter file(s)
- exact config file(s)
- env variable name proposal
- payload schema
- validation steps
- whether to emit on:
  - success
  - failure
  - both
  - or only after polling/approval
