# Architecture and failure semantics

## Components

- **HTTP API:** authenticates a configured tenant, validates bounded input, renders a pinned template version, and writes intent
  plus all requested channel rows atomically.
- **PostgreSQL 17.6:** source of truth for intents, preferences, queue state, leases, and provider-attempt receipts.
- **Worker:** leases one due row, reads current preference, checks expiry, calls one configured provider, and conditionally
  commits the result with the current fencing token.
- **Provider adapter:** bounded outbound HTTP client. Test-only HTTP is restricted to an exact configured loopback origin;
  production configuration requires HTTPS and does not follow redirects.

No external broker is used in this slice. The delivery table is both durable queue and state machine. That makes intake fanout
atomic without a dual-write window. It also binds queue throughput and retention to one PostgreSQL service, which is an explicit
scale boundary rather than a hidden production recommendation.

## Data model

| Table | Authority |
|---|---|
| `notification_intents` | immutable tenant idempotency binding, recipient reference, class, template version, schedule, expiry, priority |
| `notification_deliveries` | one channel state, frozen rendered payload/digest, due time, attempt budget, lease, terminal/provider state |
| `notification_preferences` | latest versioned tenant/recipient/channel/class decision |
| `provider_attempts` | append-by-attempt start and terminal outcome, including unknown lease expiry and provider response metadata |

Rendered content is frozen at intake so a deploy cannot silently change a retry. Preference is deliberately late-bound because an
opt-out after intake should still suppress work that has not crossed the provider-call decision. The two choices have different
consistency goals and should not be collapsed into one “read metadata from cache” step.

## Delivery state machine

| From | Trigger | To | Durable meaning |
|---|---|---|---|
| none | atomic intake | `pending` | intent and channel row exist |
| `pending` / `retry` | due claim | `leased` | one token owns the current attempt |
| `leased` | preference denies | `suppressed` | no provider call was made |
| `pending` / `retry` / `leased` | TTL boundary | `expired` | no later provider call is permitted |
| `leased` | retryable result and budget remains | `retry` | next due time and response are persisted |
| `leased` | provider `2xx` receipt | `provider_accepted` | provider accepted; device/user outcome unknown |
| `leased` | provider `2xx` but adapter receipt is unusable | `dead` | `provider_outcome_unknown`; no automatic retry |
| `leased` | permanent result or exhausted attempts | `dead` | operator or new intent is required |
| expired `leased` | recovery | `retry`, `expired`, or `dead` | old attempt becomes `lease_expired_unknown`; old token is fenced |

Only the current lease token can finish a row. `SKIP LOCKED` is used only when selecting queue work. Authoritative reads never
use it because PostgreSQL explicitly describes the resulting view as inconsistent for general-purpose reads.

## Crash and race windows

| Window | Observable result | Recovery |
|---|---|---|
| before intake transaction commits | caller has no durable acceptance | retry same idempotency key |
| after intake commit, before a worker | durable `pending` | any worker can claim |
| after lease commit, before provider call | durable `leased`; local system cannot prove whether the call started | lease expires; attempt becomes unknown and may retry |
| after provider acceptance, before local completion | provider may have produced an effect; row remains `leased` | retry can duplicate unless provider deduplicates the delivery key |
| after provider `2xx`, but its bounded receipt ID is missing | external effect may exist; adapter contract is incomplete | terminal unknown receipt; operator investigates instead of automatic retry |
| after local `provider_accepted` commit | no scheduler retry | downstream/device state remains unknown |
| preference disable before final worker read | versioned disable is observed | terminal suppression |
| preference disable after final worker read | provider request may still occur | receipt identifies the older observed version; external call cannot be retracted |

The database cannot atomically commit with APNs, FCM, email, or SMS. Therefore exactly-once external delivery is not an honest
property of this architecture. The runtime smoke turns that statement into two executable receipts instead of leaving it as a
diagram footnote.

## Ordering and fairness

Claims use priority descending, due time ascending, and UUID as a deterministic tie-break. This gives a stable local selection
order, not global delivery order. Provider latency, retries, `SKIP LOCKED`, channel independence, and device behavior can reorder
effects. Continuous high-priority traffic can starve lower priority work; production admission control or aging is not included.

## Scaling path

The current slice is plausible only while one PostgreSQL queue meets measured needs. Before moving to a broker or sharded queue:

1. preserve the immutable intake key and payload digest;
2. use a transactional outbox or change stream so database acceptance and enqueue do not become an unsafe dual write;
3. define partition keys for recipient/provider ordering and fairness;
4. retain a fencing or ownership contract for recovery;
5. keep provider attempts and preference versions queryable across retention/compaction;
6. re-run the duplicate crash counterexample against the real provider adapter.

Adding a broker without those invariants would move buffering, not solve correctness.
