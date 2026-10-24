# Public source boundary

This repository contains the portable Code AI application. Accounts, conversation data, credentials, host inventories, deployment receipts and machine-specific operator scripts belong in private storage outside Git.

Run `npm run check:public-source` before publishing. The check rejects private operational paths, hardcoded home directories, key material and known credential formats. Operators can supply additional private identifiers through `CODE_AI_PRIVATE_IDENTIFIERS_FILE`; the policy file itself must stay outside Git.

Configure provider homes, external services and public URLs through the documented environment variables. The optional incident integration requires `CODEX_INCIDENT_FAILURE_URL` and, when applicable, `CODEX_INCIDENT_FAILURE_AUTH_TOKEN`. No existing host, customer or service identity is included in defaults.
