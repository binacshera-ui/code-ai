---
name: code-ai-conversation-search
description: Search CODE-AI/Codex conversation history with evidence and strict scope control. Use when the user asks to find, recover, locate, compare, or link to something discussed in the current conversation, every conversation in the active project, or all accessible conversations; also use for requests such as "איפה דיברנו על", "חפש בסשנים", "מצא את השיחה", or "תן קישור לסשן" while Conversation Search Mode is active.
---

# Conversation Search

Treat conversation archives as evidence, not as ordinary project text. Search only the scope supplied by Conversation Search Mode and never broaden it silently.

## Workflow

1. Read the active scope block injected by CODE-AI. Record the current session ID, project root, profile stores, title file and result URL before searching.
2. Extract two query sets:
   - exact phrases, names, paths, ports, error fragments and dates;
   - 2–6 distinctive fallback terms. Drop generic words such as “שיחה”, “מערכת”, “משהו”, “תבדוק”, “the”, “and”, and “project”.
3. Run the bundled search script first. It searches only real user/assistant messages, excludes tool payload noise, filters by scope, deduplicates copied fork history and returns evidence with source files and session links.
4. If the exact search is empty, retry once with shorter distinctive terms or known spelling variants. Do not search unrelated roots just to manufacture a result.
5. Open only the strongest candidate JSONL files with `rg`/`jq` to inspect the surrounding turn and verify meaning. Distinguish a direct discussion from a passing mention, copied context, a tool log, or a later fork.
6. Return the best match first with title, date, profile, project path, a concise paraphrase, a short supporting excerpt, confidence and a direct session link. List alternatives only when ambiguity is real.

## Script

Use `scripts/search_sessions.mjs` from this skill directory. Pass every profile store supplied by the mode:

```bash
node scripts/search_sessions.mjs \
  --scope project \
  --query 'מערכת לוגים חדשה' \
  --project-root /root/projects/bina-cshera \
  --session-id SESSION_ID \
  --profile developer=/home/developer/.codex \
  --profile developer2=/home/developer2/.codex \
  --titles-file /path/to/session-titles.json \
  --index-root /path/to/.code-ai/local/conversation-search-mode/index-v1 \
  --base-url https://app-codex.example \
  --limit 20
```

Scopes:

- `current`: accept matches only from `--session-id`.
- `project`: accept sessions whose canonical `cwd` is the project root or lies beneath it.
- `all`: search every supplied profile store, including archived sessions.

The script emits JSON. Treat `warnings` and `scope` as part of the result. A zero-result response is valid evidence; report it and suggest the narrowest useful query refinement.

The script maintains a private condensed index containing only real conversation messages. The first search can take longer while the index is built; later searches inspect only bytes appended to source histories and query the condensed index. Do not bypass or delete this index during normal searches. If it is missing or damaged, the script rebuilds it from the immutable session archives.

## Verification rules

- Prefer `event_msg.payload.type=user_message|agent_message`. Do not treat system instructions, tool calls, tool output, compaction text or embedded page content as the user's discussion.
- Forks may repeat the same old turn. Prefer the earliest original session carrying the turn; mention a fork only when the later branch contains new relevant discussion.
- Match project scope from `session_meta.payload.cwd`, not from a project path merely mentioned inside a message.
- Never expose tokens, cookies, authentication files or unrelated private conversation content. Quote only the minimum evidence needed.
- Do not edit, delete, restore or compact session files while searching.
