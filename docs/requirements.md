# Problem contract and invariants

## Scenario, not a production forecast

The design exercise accepts the chapter's synthetic daily volume only as a sizing scenario: 10 million push, 1 million SMS,
and 5 million email notifications per day. That is about 185 accepted channel deliveries per second on average. A declared
10x peak assumption gives about 1,850 per second. No source says a single region, PostgreSQL instance, provider account, or
worker fleet can sustain that peak, and this repository does not claim it.

At an assumed 1 KiB of durable intent, rendered payload, state, and attempt metadata per channel delivery, 16 million daily
deliveries are roughly 16 GB/day before indexes, replication, WAL, provider receipts, analytics, and retention. A 30-day hot
window is therefore roughly 480 GB raw under that explicit assumption. These figures choose a test shape; they are not facts
about APNs, FCM, email, SMS, or any real product.

## Users and behavior

- A trusted tenant service submits one notification intent for one opaque recipient reference, one immutable template version,
  one to three channels, a schedule, an expiry, a class, and an idempotency key.
- Marketing notifications default to suppressed until that recipient has explicitly enabled the channel. Transactional
  notifications default to enabled but still honor an explicit disable. This is repository policy, not a legal-compliance claim.
- A worker sends only due, nonexpired deliveries. It rechecks the latest committed preference immediately before the provider
  call and records which preference version it observed.
- A provider response can prove that the provider accepted or rejected a request. It does not prove device arrival, display,
  reading, clicking, or business outcome.
- Operations can inspect intent and per-channel state without exposing bearer tokens, idempotency keys, recipient references,
  rendered content, or provider message identifiers in logs.

## Functional requirements

1. Atomically create an immutable notification intent and one durable delivery row per requested channel.
2. Replay the same tenant/idempotency key and payload to the original intent; reject a changed payload under the same key.
3. Schedule and expire deliveries using persisted timestamps.
4. Let concurrent workers claim different rows without double-leasing one row.
5. Suppress a delivery when the current preference policy denies it.
6. Classify provider acceptance, invalid recipients, permanent request failures, throttling, temporary server failures, and
   network uncertainty into explicit terminal or retry states.
7. Bound attempts, exponential backoff, jitter, `Retry-After`, and expiry; exhausted work becomes dead rather than looping.
8. Recover expired leases after process death with a new fencing token and a new attempt number.
9. Preserve every provider attempt and state transition needed to explain duplicates and recovery.
10. Demonstrate both sides of the provider crash window with real processes and HTTP: an idempotent provider can collapse a
    repeated delivery key, while a non-idempotent provider can produce two effects.

## Non-goals

- Real APNs, FCM, SMS, or email authentication and protocol conformance.
- Address book, device-token registration, token encryption, contact verification, unsubscribe UI, legal classification,
  localization, HTML email, attachments, campaigns, topics, broadcast fanout, analytics, open/click tracking, or billing.
- Exactly-once provider effects, device delivery, ordering across channels, cross-region active-active operation, database
  failover, backup/restore, queue partitioning, autoscaling, production capacity, deployment, SLA, or external acceptance.

## Invariants

1. **Stable intent:** `(tenant_id, idempotency_key)` names one immutable digest and one intent forever.
2. **Atomic fanout:** an accepted intent and all requested channel rows commit together or not at all.
3. **One active lease:** a delivery has at most one current lease token; only that token can finish its attempt.
4. **No early send:** a provider call cannot start before `scheduled_at_ms` or the current retry time.
5. **No expired send:** the worker checks expiry after claim and before the provider call; a retry is never scheduled at or
   beyond expiry.
6. **Late preference:** a committed disable observed before the worker's final preference decision suppresses the call. A
   concurrent disable after that decision cannot retract an external request and is recorded as an unavoidable race boundary.
7. **Bounded retry:** only retryable outcomes schedule another attempt; attempt budget and expiry are hard stops.
8. **Receipt honesty:** `provider_accepted` means the configured provider accepted the request, never that the user received it.
9. **Duplicate honesty:** a crash after provider acceptance but before local commit leaves an unknown outcome. A repeated stable
   delivery key helps only when that provider contract actually deduplicates it.
10. **Identity minimization:** application logs contain counts, states, and opaque correlation hashes, never raw credentials,
    recipient references, idempotency keys, content, or provider receipt identifiers.

## Acceptance evidence

- Deterministic unit tests for validation, canonical digests, templates, policy defaults, retry classification, backoff, and HTTP.
- Real PostgreSQL 17.6 integration tests for unique constraints, atomic fanout, `SKIP LOCKED`, fencing, late preferences,
  scheduling, expiry, lease recovery, and attempt receipts.
- A loopback provider and child-process `SIGKILL` smoke for the provider-accepted crash window and duplicate counterexample.
- A bounded PostgreSQL benchmark that records raw acceptance and lease lifecycle timing without a shared-runner throughput gate.
- Locked dependencies, pinned Actions, dependency audit, clean public main branch, and explicit evidence exclusions.
