# Public source boundary

This repository contains the full portable Code AI product: the chat client,
Workbench, provider integrations, durable queue, browser tools, extension, tests
and product documentation. Named Bina integrations are optional source features,
not bundled access to those services. Accounts, conversation data, credentials,
host inventories, deployment receipts and machine-specific operator scripts
belong in private storage outside Git.

Run `npm run check:public-source` before publishing, together with a secret scan
of the exact source snapshot. The check rejects private operational paths,
hardcoded home directories, key material and known credential formats.
Operators can supply additional private identifiers through
`CODE_AI_PRIVATE_IDENTIFIERS_FILE`; publicly documented product names are not
treated as secrets, and the policy file itself stays outside Git.

Configure provider homes and external services through the documented environment
variables. The optional incident integration uses `CODEX_INCIDENT_FAILURE_URL`
and `CODEX_INCIDENT_FAILURE_AUTH_TOKEN`. Workbench SSO requires its separately
configured `BINA_WORKBENCH_SSO_SECRET_FILE`. No credentials or customer sessions
are included. The standalone exporter remains available when a reduced package
without these integrations is desired; that is not the scope of this repository.
