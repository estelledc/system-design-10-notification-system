# Operations runbook

## Before starting

1. Provision PostgreSQL with backups, restore drills, WAL/disk monitoring, connection limits, and retention decisions. None of
   those production controls is supplied by this repository.
2. Apply migrations, then use one tenant token and a bounded loopback/staging provider to validate state and receipts.
3. Configure real provider endpoints only over HTTPS. Store credentials outside source control and rotate them through the
   platform secret system.
4. Review template content, notification class, recipient ownership, opt-in/out policy, schedule, expiry, attempt budget,
   provider quotas, quiet hours, privacy, and jurisdiction-specific requirements with the responsible owners.
5. Ramp traffic gradually. The included benchmark is a regression observation, not a launch capacity plan.

## Metrics and alerts

- intake created/replay/conflict rates by tenant and channel count;
- oldest due age and counts by `pending`, `retry`, `leased`, `dead`, `expired`, and `suppressed`;
- lease-expiry and provider-receipt unknown-outcome rates, separated from each other, plus attempts per delivery;
- provider status/reason families, `Retry-After`, throttle duration, timeout, and authentication/configuration errors;
- preference default-versus-explicit decisions and version age, without recipient labels;
- provider acceptance latency and ratio, explicitly not named delivery success;
- PostgreSQL connections, transaction latency, row-lock waits, WAL, table/index bytes, dead tuples, autovacuum, disk, replica lag,
  and backup/restore age.

Alert labels must not contain recipient references, idempotency keys, rendered content, credentials, or provider message IDs.

## Provider throttling or outage

- Honor a bounded `Retry-After`; otherwise use provider-specific exponential backoff and jitter.
- Reduce admission or worker concurrency before increasing retry volume. Retries amplify an outage when all workers synchronize.
- Stop retrying work that has expired. Do not extend TTL silently just to improve a success graph.
- Separate provider authentication/configuration failures from transient `429`/`5xx`; repeated permanent errors should page an
  owner, not burn every attempt.
- Check the provider's current official status and error contract before changing classification.

## Invalid recipient surge

- Quarantine the affected adapter/credential/topic if failures span many recipients; this can be configuration, not token churn.
- For a provider-specific unregistered response, stop using that endpoint according to that provider's contract.
- This slice stores only an opaque recipient reference and has no token registry, so deactivation must occur in the external
  contact directory. Do not infer app uninstall or user behavior beyond the provider's documented signal.

## Lease expiry or duplicate reports

- A `lease_expired_unknown` attempt is an incident receipt, not proof that no provider call occurred.
- A `provider_outcome_unknown` attempt means the provider returned an accepting status without the bounded receipt required by
  the adapter. It is terminal to prevent an automatic duplicate; reconcile with provider-side logs before creating a new intent.
- Compare the stable delivery key and provider receipt history. If the real provider lacks idempotency, assume duplicate effects
  are possible and make the notification content/business action safe to repeat.
- Do not manually clear a current lease. Let expiry and the fencing token prevent a stale worker from committing over recovery.
- A spike suggests process death, timeouts, undersized leases, database stalls, or provider latency; investigate before raising
  the lease globally.

## Backlog and dead rows

- Use oldest due age, not queue count alone; future scheduled work is not backlog.
- Examine priority starvation and tenant/provider concentration before adding workers.
- Dead deliveries are terminal history. Replaying them creates a new intent/idempotency key after the root cause is fixed; do
  not mutate an old immutable request into a different payload.

## Retention

Define retention separately for intent variables, frozen payloads, preferences, provider attempts, and aggregate metrics. Deleting
attempts too early destroys duplicate/recovery evidence; retaining payloads forever increases privacy impact. Any compaction must
preserve referential integrity and be tested with restore, which v0.1 does not cover.
