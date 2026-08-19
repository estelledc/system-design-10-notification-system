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

## Public evidence on 2026-08-19

- The identity-safe rewrite mapped the initial commit `5fcc8fcdffcfaf2445356027da14b7657cf21746` to `69853aecc5234915c03e1a2ddd8fcbb49baef620`, and the test-correction commit `505205967c0acc5c6d5fc6f7f25e1080f7332a37` to `cfe5916409fedb00c7b060171bc8a4028e6d9195`. The linked runs in this section are historical pre-rewrite receipts bound to the old commit objects; the corresponding rewritten commits preserve their trees, messages, and timestamps.
- Implementation and test-correction commit `cfe5916409fedb00c7b060171bc8a4028e6d9195` passed the tree-equivalent public
  [CI run 32161648447](https://github.com/estelledc/system-design-10-notification-system/actions/runs/32161648447)
  on Node 22.23.2, 24.19.0, and 26.7.0, each against PostgreSQL 17.6.
- Every matrix job passed 25 deterministic unit/HTTP tests and 9 real PostgreSQL integration tests with 0 skipped. The locked
  install and repository audit each reported 0 known vulnerabilities at the configured high-or-greater threshold.
- Every runtime smoke persisted API intake, killed a child worker with `SIGKILL` after provider acceptance, recovered on attempt
  2, and produced the same counterexample: 2 requests/1 effect for the idempotent fixture versus 2 requests/2 effects for the
  non-idempotent fixture. Marketing default deny made 0 provider requests; logs contained none of the seeded raw identities;
  device-delivery claims remained 0.
- The bounded observation inserted 2,000 one-channel intents and completed 1,000 sequential lease lifecycles. Acceptance rates
  were 1,104, 1,372, and 1,566 transactions/second; lifecycle rates were 139, 157, and 158 operations/second across the three
  shared runners. These are raw receipts only, not a throughput gate or capacity claim.

The first public [CI run 32161519079](https://github.com/estelledc/system-design-10-notification-system/actions/runs/32161519079)
is intentionally retained as a red receipt. All three runtimes passed the pure gate and 7 of 8 PostgreSQL cases, then the mixed
scheduling/expiry test accidentally allowed its earlier due lease to recover and be claimed while expecting an empty queue. The
implementation behaved consistently; commit `cfe5916` isolated the two cases so each assertion owns its queue state. The next
run passed 9 of 9 instead of weakening the recovery behavior.

## Identity-safe main receipt

- Reachable `main` history was rewritten to use the repository owner's GitHub noreply identity. Every existing tree, commit message, author date, and committer date was preserved; only author and committer identity metadata changed.
- Rewritten baseline: `8bf0753bb6339a563cfe0a350370f61d540b9e58`.
- Public CI: [run 32224759104](https://github.com/estelledc/system-design-10-notification-system/actions/runs/32224759104), successful on Node 22, 24, and 26 with PostgreSQL 17.6 and the full quality gate.

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
