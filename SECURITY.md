# Security policy

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not open a public issue containing
credentials, recipient data, rendered notifications, provider receipts, or exploit details.

## Supported scope

Only the current default branch is maintained. This repository is an educational reference and is not a hosted notification
service. It contains no real provider credentials and must not be deployed as-is.

## Secret handling

- Keep API/provider credentials and database URLs in the runtime secret system, never source control.
- Tests use obvious loopback-only fixture values.
- Application logs intentionally exclude credentials, idempotency keys, recipient references, content, and provider message IDs.
- Rotate exposed credentials immediately and remove them from history using an incident-reviewed procedure.
