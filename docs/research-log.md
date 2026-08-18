# Research log and source corrections

## Snapshot boundary

- Secondary prompt source: `liquidslr/system-design-notes`, commit
  `9d8388721e7231442763ad37398b8d82224aa68f`, chapter 10 blob
  `cafa1db95d899745bdb20bdcd1955dc58fdf72be`.
- Public-source fetch and review date: 2026-08-19 (Asia/Shanghai).
- The fixed upstream tree has no license file. This repository copies no upstream prose, image, diagram, or code.
- Process deviation: chapter 10 was fetched before this repository's contract was written. Therefore this repository does not
  claim a clean closed-book baseline. The contract is source-informed; the deviation is retained here instead of rewritten away.

## What the chapter contributes

The chapter supplies a useful checklist: push, SMS, and email channels; soft-real-time delivery; schedules; opt-out; a durable
notification log; queues; workers; templates; rate limiting; retry; and monitoring. Its 10M/1M/5M daily numbers are treated as
scenario inputs only.

## Corrections that shape this implementation

1. Event-ID deduplication can converge repeated intake requests, but it cannot by itself prevent a duplicate external effect
   when the provider accepted a request and the worker died before recording that fact.
2. APNs documents best-effort behavior, possible reordering, provider-side storage/merging, throttling, and possible nondelivery.
   Its returned notification ID is an identification/debugging field, not a documented exactly-once guarantee.
3. FCM distinguishes permanent invalid-token/request failures from `429`, `500`, and `503` retry cases. Its current guidance
   requires bounded exponential backoff, jitter for fleets, `Retry-After` handling, and eventual expiry instead of infinite retry.
4. RFC 8030 states directly that a push service's `201 Created` means accepted, not delivered to the user agent. TTL, urgency,
   topic replacement, and optional receipts are provider protocol semantics, not proof of user-visible delivery.
5. PostgreSQL says `SKIP LOCKED` gives an inconsistent view unsuitable for general reads but useful for multiple consumers of a
   queue-like table. This repository uses it only for leasing work, never for authoritative intent queries.
6. The chapter's final “Distributed Crawling” optimization is unrelated to notification delivery and is treated as an editing
   defect, not a design requirement.

## Primary sources

- [Apple: Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Apple: Handling notification responses from APNs](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)
- [Firebase: FCM error codes](https://firebase.google.com/docs/cloud-messaging/error-codes)
- [Firebase: Best practices when sending at scale](https://firebase.google.com/docs/cloud-messaging/scale-fcm)
- [RFC 8030: Generic Event Delivery Using HTTP Push](https://www.rfc-editor.org/rfc/rfc8030.html)
- [PostgreSQL 17: SELECT and `SKIP LOCKED`](https://www.postgresql.org/docs/17/sql-select.html)

The public HTML/JSON bodies above were fetched into temporary evidence bundles and verified as readable. Apple’s rendered HTML
was JavaScript-thin, so the corresponding public DocC JSON endpoints were used for the complete source body. Source freshness,
provider policy, quotas, and error contracts can change; implementation claims remain bound to the verification date and tests.
