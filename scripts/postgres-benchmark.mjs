import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { PostgresNotificationStore, sha256 } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required for the PostgreSQL benchmark');
const intentCount = Number(process.env.BENCHMARK_INTENT_COUNT ?? 2_000);
const lifecycleCount = Number(process.env.BENCHMARK_LIFECYCLE_COUNT ?? 1_000);
assert.ok(Number.isInteger(intentCount) && intentCount >= lifecycleCount && intentCount <= 20_000);
assert.ok(Number.isInteger(lifecycleCount) && lifecycleCount >= 100 && lifecycleCount <= 10_000);

const pool = new Pool({ connectionString: databaseUrl, max: 24 });
const store = new PostgresNotificationStore(pool);
await store.migrate();
await pool.query(`TRUNCATE
  provider_attempts,
  notification_preferences,
  notification_deliveries,
  notification_intents`);
const version = await pool.query('SHOW server_version');

const acceptedStart = performance.now();
for (let offset = 0; offset < intentCount; offset += 32) {
  const batch = Array.from({ length: Math.min(32, intentCount - offset) }, (_, batchIndex) => {
    const index = offset + batchIndex;
    const intentId = randomUUID();
    return store.acceptIntent({
      id: intentId,
      tenantId: 'benchmark-tenant',
      idempotencyKey: `benchmark-request-${String(index).padStart(10, '0')}`,
      requestDigest: sha256(`intent-${index}`),
      recipientRef: `recipient-${String(index).padStart(10, '0')}`,
      notificationClass: 'transactional',
      templateId: 'account-alert',
      templateVersion: 1,
      variables: { title: 'Alert', body: 'Benchmark' },
      scheduledAtMs: 1_000,
      expiresAtMs: 1_000_000,
      priority: 5,
      createdAtMs: 1_000,
      deliveries: [{
        id: randomUUID(),
        channel: 'push',
        payload: { title: 'Alert', body: 'Benchmark' },
        payloadDigest: sha256(`payload-${index}`),
        maxAttempts: 5,
      }],
    });
  });
  await Promise.all(batch);
}
const acceptedElapsedMs = performance.now() - acceptedStart;

const lifecycleStart = performance.now();
for (let index = 0; index < lifecycleCount; index += 1) {
  const leaseToken = randomUUID();
  const delivery = await store.claimNext({
    nowMs: 1_000,
    leaseMs: 30_000,
    crashCooldownMs: 10_000,
    leaseToken,
    workerId: 'benchmark-worker',
  });
  assert.ok(delivery);
  await store.completeAttempt({
    deliveryId: delivery.id,
    leaseToken,
    nowMs: 1_001,
    nextStatus: 'provider_accepted',
    outcome: 'provider_accepted',
    providerStatus: 202,
    providerMessageId: `benchmark-provider-${index}`,
    preferenceVersion: 0,
  });
}
const lifecycleElapsedMs = performance.now() - lifecycleStart;
const stats = await store.stats();
assert.equal(stats.intents, intentCount);
assert.equal(stats.deliveries.provider_accepted, lifecycleCount);
assert.equal(stats.deliveries.pending, intentCount - lifecycleCount);
assert.equal(stats.attempts.provider_accepted, lifecycleCount);
await pool.end();

process.stdout.write(`${JSON.stringify({
  kind: 'single_region_postgres_notification_benchmark',
  node: process.version,
  postgres: version.rows[0].server_version,
  platform: process.platform,
  arch: process.arch,
  intentCount,
  acceptanceElapsedMs: Number(acceptedElapsedMs.toFixed(3)),
  acceptanceTransactionsPerSecond: Math.round((intentCount * 1_000) / acceptedElapsedMs),
  lifecycleCount,
  lifecycleElapsedMs: Number(lifecycleElapsedMs.toFixed(3)),
  lifecycleOperationsPerSecond: Math.round((lifecycleCount * 1_000) / lifecycleElapsedMs),
  finalProviderAccepted: stats.deliveries.provider_accepted,
  finalPending: stats.deliveries.pending,
  sharedRunnerThroughputGate: false,
  claimBoundary: 'one PostgreSQL 17.6 service, one Node process, one channel row per intent, batched intake concurrency of 32, and sequential lease completion; excludes HTTP, template rendering, preference reads, provider calls, retries, multiple workers, replication, failover, and production capacity',
})}\n`);
