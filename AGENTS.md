# Repository instructions

- Treat this repository as an evidence-first system-design practice, not a production notification service.
- Keep notification intent identity, provider acceptance, terminal delivery, and user-visible delivery as separate states.
- Never claim exactly-once external delivery; preserve the provider-accepted crash window and its counterexample.
- Do not log bearer tokens, idempotency keys, recipient references, rendered payloads, or provider message identifiers.
- Run `npm run check:ci` against PostgreSQL 17.6 before publishing implementation claims.
- Do not add a real APNs, FCM, email, or SMS credential to tests, examples, commits, or CI.
