# Live messages in an active Codex turn

## Contract

An ordinary, unscheduled composer submission uses `POST /api/codex/messages` on
capable Codex profiles. The backend checks the native turn, not a cached browser
running flag. If active, it appends to that exact turn; if idle, it uses the
existing normal send path. Explicit scheduling, recurrence, saved drafts and
other provider CLIs retain their existing paths.

The selected foundation is the installed Codex app-server 0.171.0, through the
existing product-owner frontend socket. There is no new model loop, context
manager, execution queue or native owner. No additional dependency is required.
The persistent SQLite file contains delivery receipts only; no worker executes
those records.

Active delivery uses `turn/steer` with the real `expectedTurnId`, actual user
input and a correlated `clientUserMessageId`. The text enters the native user
history and model context once. Do not repeat it in `additionalContext` or as a
synthetic tool result: doing both creates two context copies, even though only
one turn and one native user item exist. The running model/tool call is not
interrupted and no model, permission, working directory or reasoning setting is
overridden. Model/settings changes apply to the next turn.

Standalone `turn/start.toolOutput` is deliberately not used as an active-only
primitive: it can start a turn after an idle race and does not enforce the
required expected-turn guard. Repeating a native client message ID is **not**
native deduplication.

Native 0.171 rejects `turn/steer` with an empty input, so a tool-result-only
carrier is not a substitute for native user input. Input-only steering was
verified against the real binary and owner broker during held model sampling
and a running shell, with exactly one copy in subsequent model requests.

## Delivery and retry

- A durable reservation precedes native dispatch; a delivered receipt is
  correlated by `clientRequestId`, profile, session and turn.
- A repeated delivered request returns the receipt without sending again.
- An uncertain result is reconciled using the native user item's `clientId` in
  the original turn. Missing history is not permission to resend.
- A stale/ended turn is rejected without falling back to a new turn or queue.
  The draft remains; another explicit send may use a fresh request ID after
  proven non-delivery. Unknown delivery retains its original ID and endpoint.
- A regular-send receipt is checked before considering active delivery, so a
  lost acknowledgement cannot append the original prompt to its own run.
- Only acknowledged text, attachments and browser selections are cleared.
  Deferred next-turn context selections are not silently consumed by a live
  append. Explicit schedules are never injected early.
- Capability is scoped to server and profile. An older remote backend must not
  silently queue a known-active follow-up. A new conversation still waiting for
  its native session binding retains the draft until that binding is available.
- The internal `contextText` field remains in the payload hash for compatibility
  with existing delivery receipts. It is not sent to the native model as a
  second context item. Old delivered and lost-ACK receipts still reconcile
  without resubmission after upgrading the representation.

## Agent instructions for Bina Cshera 3.0 Remix

The following is an implementation brief, not a claim that Bina has been changed:

```text
Implement live user input in Remix: when an ordinary unscheduled message is
sent while the conversation has an active native Codex turn, attach it to that
same turn immediately, without cancelling generation/tools, starting another
turn, or adding a FIFO/admission queue item. Preserve explicit scheduling and
recurrence; preserve normal idle/new-conversation behavior.

Start from SystemView.tsx: the isSubmitting -> enqueueComposerTurn(mode:immediate)
branch currently creates the unwanted queue. Reuse steerSessionTurn in
codex-runtime-manager.mjs, shared-codex-runtime-manager.mjs,
canonical-native-control-rehydration.mjs and codex-app-server-chat.mjs. Route
through the existing server-runtime.ts/BST ownership boundary. Do not route live
input through completeChat, FIFO or remixControlPlaneRuntime.admit.

Inspect the actually running binary and generated schema; do not infer support
from its custom 0.0.0 version label. Prove turn/steer with expectedTurnId,
clientUserMessageId and the actual user input ONLY. Do not duplicate the text in
additionalContext or a synthetic tool output. Verify exactly one text copy in
model context and one persisted real userMessage. The goal is noninterrupting
native steering, not forcing a tool-result representation. Do not use unguarded turn/start.toolOutput
as an active-only primitive; it can start a new turn when completion wins a race.

Preserve canonical conversation/turn IDs versus original provider turn IDs, and
rehydrate authority through the shared owner bus. Preserve the current model,
tools, permission and accounting context. Desktop-local needs equivalent control
through local-conversations.ts and src-tauri/src/local_conversations/runtime.rs,
using its existing single writer/stdout reader, not a second engine or reader.
Do not merely remove privateConversation or browser busy guards; prove support
for each path and advertise a scoped capability.

Implement durable request idempotency and delivery receipts, not an execution
queue. Native repeated client IDs alone do not deduplicate. Reserve before send;
on lost ACK/restart reconcile native history by clientId without blind resend.
Reject a stale expectedTurnId without queue/start fallback. Keep the draft on
unknown delivery; clear only on a correlated accepted receipt. Keep a retry on
its original endpoint and ID. Handle two quick sends and session-binding races.

Test with neutral inputs: append during model streaming and a harmless running
shell command, preserve the same turn ID, do not abort the shell, observe real
user messages with exactly one context copy, repeat a request once only,
recover lost ACK/restart, test completion race and profile/conversation isolation,
and prove explicit schedules remain scheduled. Cover shared/server and
desktop-local separately. Follow the current repo's normal build/deploy process;
report exactly which paths were tested and which are live.
```

### נוסח קצר להעתקה לסוכן רמיקס

```text
הוסף ברמיקס צירוף הודעה רגילה לסבב Codex פעיל, פעם אחת בלבד,
בלי לעצור את המודל או הכלים ובלי ליצור פריט FIFO או סבב חדש.
השתמש ב-turn/steer עם expectedTurnId, clientUserMessageId והקלט האמיתי בלבד;
אל תשכפל את הטקסט ב-additionalContext או בתוצאת כלי מדומה.
תזמון מפורש וחזרתיות יישארו במנגנון התזמון, ושליחה בזמן שאין ריצה
תמשיך במסלול הרגיל.

בדוק את SystemView.tsx ואת המסלול isSubmitting -> enqueueComposerTurn(immediate).
חבר את המסירה ל-steerSessionTurn הקיים דרך runtime-manager, shared owner
ו-server-runtime/BST, תוך שמירת המיפוי בין מזהי הסבב הקנוניים למזהי native.
אל תעביר הודעה חיה דרך completeChat, FIFO או remixControlPlaneRuntime.admit.
ב-desktop-local השתמש בערוץ הבקרה ובקורא stdout היחידים שכבר קיימים.

שמור קבלות מסירה ומזהה בקשה עמיד. אחרי אובדן אישור בדוק את ההיסטוריה
המקורית לפי clientId; אל תשדר שוב על סמך timeout. סבב שהסתיים בדיוק
בזמן השליחה צריך להחזיר דחייה בלי מעבר אוטומטי לתור. נקה טיוטה רק
אחרי אישור מסירה תואם.

בדוק מול הבינארי המותקן בפועל: הודעה בזמן streaming ובזמן כלי shell,
אותו turnId, טקסט פעם אחת בקונטקסט ובהיסטוריה, המשך כלי ללא ביטול,
retry/restart ללא כפילות, מרוץ סיום, והפרדה מתזמון. דווח מה נבדק ומה נפרס.
```
