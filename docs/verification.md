# Verification record

## Gates

`npm run check` executes repository/static checks, deterministic unit and loopback HTTP tests, and
`npm audit --audit-level=high`.

With `DATABASE_URL` bound to PostgreSQL 17.6, `npm run check:ci` additionally executes:

1. real unique-constraint idempotency convergence and atomic fanout rollback;
2. concurrent `SKIP LOCKED` leasing, lease-expiry recovery, exact-token fencing, scheduling, expiry, late preferences, and retry
   receipts, including an accepted-but-unusable provider receipt that stops without retry;
3. an API intake plus child-worker `SIGKILL` smoke against idempotent and non-idempotent loopback providers;
4. a bounded PostgreSQL intake/lease benchmark that asserts final state but does not fail on a shared-runner throughput number.

No test is skipped. CI runs the locked gate on Node 22, 24, and 26 with PostgreSQL 17.6.

Every `provider_accepted` assertion is provider acceptance only. The gate makes zero device-delivered or user-visible-delivery
claims, including when an idempotent fixture collapses a repeated delivery key.

## Current local evidence

- Node 26 syntax checks pass for current source, scripts, and tests.
- 25 deterministic unit/HTTP tests pass with 0 skipped.
- `npm install --ignore-scripts` reported 0 known vulnerabilities at high-or-greater audit scope.
- PostgreSQL integration, runtime crash, benchmark, and public CI receipts are pending the first publication. This section will
  be replaced with commit-bound run URLs only after those environments actually pass.

## Evidence boundary

Passing these gates does not prove:

- APNs, FCM, email, or SMS credentials, payload conformance, quota, token lifecycle, or provider idempotency;
- device receipt, display, reading, click, conversion, or any user/business outcome;
- exactly-once external effects, legal consent, preference-race elimination, quiet hours, localization, broadcast/fanout,
  campaign analytics, or billing;
- PostgreSQL crash/power-loss durability, backup/restore, failover, replication, vacuum/retention under load, broker migration,
  partitioning, multi-region behavior, production capacity, deployment, SLA, or external acceptance.

The provider fixtures are executable counterexamples, not substitutes for provider sandboxes or production contracts. The
benchmark excludes HTTP intake, template rendering, preference reads, provider calls, retry delays, multiple worker processes,
replication, failover, and network latency.

## Reproduce

```sh
npm ci --ignore-scripts
npm run check
DATABASE_URL=postgres://... npm run check:ci
```
