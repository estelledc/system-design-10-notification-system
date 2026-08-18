# ADR 0001: Atomic PostgreSQL queue and at-least-once provider boundary

## Status

Accepted for the v0.1 evidence slice.

## Context

The intake API must return one durable idempotent result and create all selected channel work without losing a row between a
database commit and a separate queue publish. The system must also demonstrate the unavoidable uncertainty when a remote
provider accepts a request but the worker dies before recording that response.

## Decision

Use PostgreSQL as both source of truth and bounded work queue:

- one transaction inserts the immutable intent and all channel deliveries;
- workers claim due rows with `FOR UPDATE SKIP LOCKED`, then commit a lease token before external I/O;
- every completion compares the exact token, so an expired worker cannot overwrite a successor;
- provider attempt rows begin with the lease and end with accepted, retry, suppressed, expired, permanent, exhausted,
  `provider_outcome_unknown`, or `lease_expired_unknown` outcome;
- a provider `2xx` is named `provider_accepted`, not delivered;
- a `2xx` without the adapter's bounded receipt identifier stops as `provider_outcome_unknown`, because retrying a possibly
  completed external effect would silently trade loss risk for duplicate risk;
- retries reuse a stable delivery key, but exactly-once behavior is claimed only for a test provider that explicitly implements
  that contract. A second fixture intentionally creates two effects.

## Alternatives rejected for this slice

- **Database then broker publish:** introduces a dual-write loss window unless an outbox/CDC mechanism is also built and tested.
- **Broker only:** does not give the API an immutable, queryable tenant idempotency result or preference/attempt history.
- **Hold a database transaction open across provider I/O:** prolongs locks, couples database health to remote latency, and still
  cannot atomically commit the external system.
- **Mark accepted before calling the provider:** can lose notifications if the process dies before the call.
- **Retry plus event-ID dedup and call it exactly once:** intake dedup does not close the provider-accepted/local-commit window.

## Consequences

- The main correctness path is compact and can be verified with real PostgreSQL constraints and process crashes.
- Polling, indexes, WAL, row churn, vacuum, retention, and one-database availability become explicit capacity/operations limits.
- `SKIP LOCKED` provides parallel queue consumption but no authoritative consistent view and no global effect order.
- External effects remain at least once in the unknown window unless the selected provider has a verified idempotency contract.
- Scaling to a broker requires a separately tested outbox/CDC migration; it is not an automatic component swap.
