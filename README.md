# Evidence-first notification dispatcher

This repository turns a broad “notification system” prompt into one executable question:

> After a notification intent is accepted, what can the system truthfully prove across scheduling, preferences, provider
> throttling, process death, and retries?

The answer is a PostgreSQL-backed reference slice with immutable intake idempotency, one durable row per channel, leased workers,
late-bound preference decisions, bounded provider retry, append-only attempt receipts, and an explicit duplicate counterexample.
It deliberately stops at provider acceptance. It never labels that state as device delivery or user engagement.

## Business behavior

1. A trusted tenant submits an opaque recipient reference, immutable template version, variables, channels, schedule, expiry,
   class, and idempotency key.
2. PostgreSQL commits the intent and all channel deliveries in one transaction. Replaying the same key returns the original
   intent; changing any material field returns a conflict.
3. Workers lease due rows with `FOR UPDATE SKIP LOCKED`. A unique lease token fences every completion.
4. Immediately before the provider call, the worker reads the latest preference. Marketing defaults to deny; transactional
   defaults to allow unless explicitly disabled. This is local policy, not a compliance claim.
5. `2xx` becomes `provider_accepted`. `429` and selected temporary failures use bounded backoff; invalid recipients and permanent
   request errors become terminal; expiry and attempt budget stop retries. A `2xx` without the adapter's bounded receipt ID is
   terminal `provider_outcome_unknown`: the provider may have acted, so an automatic retry would be dishonest.
6. If the process dies after the provider accepts but before PostgreSQL records that fact, the lease later becomes
   `lease_expired_unknown`. Retrying can duplicate the external effect unless that provider contract deduplicates the stable
   delivery key.

```text
tenant API -> intent + channel rows (one PostgreSQL transaction)
                  |
                  v
       due-row lease + fencing token
                  |
          current preference
             /          \
       suppressed     provider HTTP
                         |
             accepted / retry / dead
                         |
                append-only attempt receipt
```

The detailed state machine and crash windows are in [architecture](docs/architecture.md).

## Scenario arithmetic

The prompt's synthetic 16 million total channel deliveries/day are about 185/second on average. A declared 10x peak assumption
is about 1,850/second. Assuming 1 KiB of raw durable data per channel gives about 16 GB/day and 480 GB for 30 days before
indexes, WAL, replicas, provider metadata, and analytics. These numbers scope the exercise; neither the implementation nor its
benchmark proves that capacity.

## Run locally

Requirements: Node 22 or later and PostgreSQL 17.6. The included Compose file uses a local-only development credential.

```sh
docker compose up -d postgres
npm ci --ignore-scripts
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/notification_system
npm run check:ci
```

The API and worker are separate commands:

```sh
node src/main.js migrate
node src/main.js serve
node src/main.js work-once
node src/main.js stats
```

`serve` additionally requires `AUTH_TOKENS_JSON`. `work-once` requires operator-controlled `PROVIDER_URLS_JSON`; HTTPS is
mandatory except for an exact loopback origin under `NODE_ENV=test`. See [API contracts](docs/api.md) and the
[operations runbook](docs/operations.md).

## Verification

The local pure gate runs static checks, deterministic unit/loopback HTTP tests, and dependency audit. The CI gate additionally
starts real PostgreSQL 17.6, executes database concurrency/fencing tests, kills worker processes after provider acceptance,
and records a bounded benchmark without using shared-runner wall time as a pass/fail capacity promise.

```sh
npm run check
DATABASE_URL=postgres://... npm run check:ci
```

No test is allowed to skip. Current public receipts are recorded only after publication in [verification](docs/verification.md).

## Clean-room boundary

The exercise was prompted by chapter 10 of `liquidslr/system-design-notes` at fixed commit
`9d8388721e7231442763ad37398b8d82224aa68f`. That tree has no license file, so no upstream prose, images, diagrams, or code are
copied here. Architecture, implementation, tests, and wording are original; current provider behavior is checked against primary
Apple, Firebase, IETF, and PostgreSQL sources listed in the research log.

## What this repository does not prove

- real APNs, FCM, email, or SMS protocol compatibility;
- exactly-once provider effects or device/user delivery;
- legal consent, address ownership, token encryption, campaign/fanout, open/click analytics, or billing;
- database failover, backup/restore, partitioned queues, multiple regions, production capacity, deployment, SLA, or external
  acceptance.

## License

MIT. See [LICENSE](LICENSE).
