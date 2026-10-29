# Manual OpenAI API login

The Codex account panel supports ChatGPT device login and saved OpenAI API keys.
Disconnect the existing account, select a saved key or save a new one, then click
Connect. Saving a key does not connect it. Choosing a different key or returning
to ChatGPT requires another explicit logout. Logout preserves saved keys,
conversations, files, and queue entries.

For a managed shared owner, Code AI invokes native `account/login/start` with
`type: apiKey` inside the same owner and `CODEX_HOME`. The selected secret travels
through stdin and the existing private local socket, never command arguments.
Other Codex profiles use `codex login --with-api-key` through stdin. Authentication
status is independent from ChatGPT usage; API mode does not display ChatGPT quota,
subscription credit, or Full Reset. Native success means the key is configured;
it does not verify OpenAI credit, funding, model access, or organization quota.

The private registry defaults to `~/.code-ai-private/openai-credentials.json`.
`CODE_AI_OPENAI_CREDENTIALS_FILE` overrides it. The directory must be private
(0700), and files must be private regular files (0600). A registry has a single
writing server process. Saved keys are bound to the selected server's profile ID
and canonical Codex home. List and save responses expose only IDs, labels, masked
suffixes, source, and creation time. Registry errors do not echo secret input.
Full operator file/terminal access retains its existing authority to read local
credentials, as it does for native `auth.json`.

Optional provisioned credentials use `CODE_AI_OPENAI_CREDENTIALS_SEED_FILE` and
`CODE_AI_OPENAI_CREDENTIALS_SEED_PROFILES` (comma-separated IDs, or `*`). Neither
enables a pool or automatic switching. The private seed JSON contains
`accounts: [{accountId, label, apiKey}]`. Removing a seed entry creates a local
profile tombstone; it does not modify the source secret file.

Manual shared-owner mutations check loaded native thread status and refuse when
work is active. The owner broker also rejects account mutations during its
reserved work. The preflight itself is not an atomic lock across independent
clients; ordinary native authentication semantics still apply. No work is
interrupted, scheduled again, or replayed by these account actions.

The focused tests use synthetic credentials and mock providers. The optional
installed-native integration test uses an isolated `CODEX_HOME` and localhost
Responses endpoint. It confirms native API A → logout → API B on the same owner
and thread, the actual Authorization header, and preserved prior history. It does
not use real keys or call OpenAI.
