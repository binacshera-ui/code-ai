# Code-AI Regular Session Trigger Contract

This reference is the source-of-truth for how a **regular session trigger** works in `code-ai`.

## Runtime Files

- `web/app/server/codexRoutes.ts`
- `web/app/server/codexSessionTriggers.ts`
- `web/app/client/src/components/codex/CodexMobileApp.tsx`

## What A Trigger Is

A trigger belongs to one **existing normal session**.

Stored shape:

- `id`
- `profileId`
- `sessionId`
- `label`
- `token`
- `createdAt`
- `updatedAt`
- `lastTriggeredAt`
- `lastPayloadPreview`

Storage file:

- `.code-ai/session-triggers.json`

## Management Endpoints

Authenticated management routes:

- `GET /api/codex/sessions/:sessionId/trigger?profile=...`
- `POST /api/codex/sessions/:sessionId/trigger`
- `DELETE /api/codex/sessions/:sessionId/trigger?profile=...`

Creation body:

```json
{
  "profileId": "gemini-developer",
  "label": "התראת שירות חיצונית",
  "rotateToken": false
}
```

## Fire Endpoint

External trigger route:

- `POST /api/codex/session-triggers/:triggerId/fire?token=...`

Token can arrive by:

- query string `token`
- header `x-code-ai-trigger-token`

The route does all of this:

1. validates trigger + token
2. resolves profile
3. resolves target session detail
4. loads the session instruction if one exists
5. converts request body into a queued prompt
6. enqueues a queue item on that exact session
7. records `lastTriggeredAt` and payload preview

## Accepted Payload Shape

The fire route accepts these fields:

- `prompt`
- `message`
- `content`
- `source`
- `service`
- `payload`
- `data`
- `details`
- optional execution overrides:
  - `model`
  - `reasoningEffort`
  - `permissionModeId`

The normalized prompt built by the server looks like:

```text
הופעל טריגר חיצוני עבור הסשן הזה.

שם הטריגר: ...

מקור הטריגר: ...

תוכן המשימה:
...

Payload נלווה:
{ ... }

טפל בזה כמשימה חדשה בתוך אותו סשן, בלי לאבד את ההקשר הקיים של השיחה.
```

## Recommended Payload Pattern

Use:

```json
{
  "prompt": "בדוק כעת את התקלה והחזר מסקנה ברורה.",
  "source": "service-name",
  "payload": {
    "service": "service-name",
    "event": "job_failed",
    "status": "failed",
    "workId": "123",
    "error": "timeout"
  }
}
```

Keep the `prompt` short and actionable.

Keep the structured facts under `payload`.

## Validation Checklist

1. Trigger exists on the target session.
2. Full signed URL is available to the emitter service.
3. Manual POST returns `202`.
4. Queue item is created for the same `sessionId`.
5. Queue item completes.
6. The target session shows the new user-like trigger task and assistant response.
