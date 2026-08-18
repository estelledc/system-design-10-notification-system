import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import {
  DependencyError,
  LeaseLostError,
  NotificationService,
  NotificationWorker,
  PostgresNotificationStore,
  ProviderProtocolError,
  RequestConflictError,
  createDefaultTemplateRegistry,
} from '../../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required for PostgreSQL integration tests');

let pool;
let store;
let nowMs;
let service;

before(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 24 });
  store = new PostgresNotificationStore(pool);
  await store.migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE
    provider_attempts,
    notification_preferences,
    notification_deliveries,
    notification_intents`);
  nowMs = 1_000;
  service = new NotificationService({
    store,
    templates: createDefaultTemplateRegistry(),
    clock: () => nowMs,
  });
});

after(async () => {
  await pool.end();
});

function request(overrides = {}) {
  return {
    recipientRef: 'recipient-001',
    notificationClass: 'transactional',
    templateId: 'account-alert',
    templateVersion: 1,
    variables: { title: 'Alert', body: 'Changed' },
    channels: ['push', 'email'],
    expiresAtMs: 1_000_000,
    ...overrides,
  };
}

async function submit(key, overrides = {}) {
  return service.submit({
    tenantId: 'tenant-a',
    idempotencyKey: key,
    request: request(overrides),
  });
}

test('real unique constraints converge 32 concurrent retries and reject payload drift', async () => {
  const results = await Promise.all(Array.from({ length: 32 }, () => (
    submit('concurrent-request-0001')
  )));
  assert.equal(new Set(results.map((result) => result.intentId)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.ok(results.every((result) => result.deliveries.length === 2));
  const counts = await pool.query(`SELECT
    (SELECT count(*)::integer FROM notification_intents) AS intents,
    (SELECT count(*)::integer FROM notification_deliveries) AS deliveries`);
  assert.deepEqual(counts.rows[0], { intents: 1, deliveries: 2 });
  await assert.rejects(
    submit('concurrent-request-0001', { variables: { title: 'Changed', body: 'Different' } }),
    RequestConflictError,
  );
});

test('intent and all channel rows roll back together when fanout violates a constraint', async () => {
  const intentId = randomUUID();
  await assert.rejects(store.acceptIntent({
    id: intentId,
    tenantId: 'tenant-a',
    idempotencyKey: 'atomic-fanout-key-0001',
    requestDigest: 'a'.repeat(64),
    recipientRef: 'recipient-001',
    notificationClass: 'transactional',
    templateId: 'account-alert',
    templateVersion: 1,
    variables: { title: 'Alert', body: 'Changed' },
    scheduledAtMs: 1_000,
    expiresAtMs: 10_000,
    priority: 5,
    createdAtMs: 1_000,
    deliveries: [
      { id: randomUUID(), channel: 'push', payload: { body: 'one' }, payloadDigest: 'b'.repeat(64), maxAttempts: 5 },
      { id: randomUUID(), channel: 'push', payload: { body: 'two' }, payloadDigest: 'c'.repeat(64), maxAttempts: 5 },
    ],
  }), DependencyError);
  const counts = await pool.query(`SELECT
    (SELECT count(*)::integer FROM notification_intents) AS intents,
    (SELECT count(*)::integer FROM notification_deliveries) AS deliveries`);
  assert.deepEqual(counts.rows[0], { intents: 0, deliveries: 0 });
});

test('SKIP LOCKED leases distinct due rows to concurrent workers', async () => {
  for (let index = 0; index < 8; index += 1) {
    await submit(`queue-request-${String(index).padStart(12, '0')}`, {
      recipientRef: `recipient-${String(index).padStart(3, '0')}`,
      channels: ['push'],
    });
  }
  const leases = await Promise.all(Array.from({ length: 8 }, (_, index) => store.claimNext({
    nowMs,
    leaseMs: 10_000,
    crashCooldownMs: 0,
    leaseToken: randomUUID(),
    workerId: `worker-${index}`,
  })));
  assert.equal(new Set(leases.map((lease) => lease.id)).size, 8);
  assert.ok(leases.every((lease) => lease.attempts === 1 && lease.status === 'leased'));
  assert.equal(await store.claimNext({
    nowMs,
    leaseMs: 10_000,
    crashCooldownMs: 0,
    leaseToken: randomUUID(),
    workerId: 'worker-extra',
  }), null);
  const attempts = await pool.query('SELECT count(*)::integer AS count FROM provider_attempts');
  assert.equal(attempts.rows[0].count, 8);
});

test('expired lease records an unknown outcome and the new token fences the old worker', async () => {
  await submit('lease-recovery-key-0001', { channels: ['push'] });
  const firstToken = randomUUID();
  const first = await store.claimNext({
    nowMs: 1_000,
    leaseMs: 100,
    crashCooldownMs: 0,
    leaseToken: firstToken,
    workerId: 'worker-first',
  });
  const secondToken = randomUUID();
  const second = await store.claimNext({
    nowMs: 1_100,
    leaseMs: 100,
    crashCooldownMs: 0,
    leaseToken: secondToken,
    workerId: 'worker-second',
  });
  assert.equal(second.id, first.id);
  assert.equal(second.attempts, 2);
  await assert.rejects(store.completeAttempt({
    deliveryId: first.id,
    leaseToken: firstToken,
    nowMs: 1_101,
    nextStatus: 'provider_accepted',
    outcome: 'provider_accepted',
    providerStatus: 202,
    providerMessageId: 'stale-provider-id',
    preferenceVersion: 0,
  }), LeaseLostError);
  await store.completeAttempt({
    deliveryId: second.id,
    leaseToken: secondToken,
    nowMs: 1_102,
    nextStatus: 'provider_accepted',
    outcome: 'provider_accepted',
    providerStatus: 202,
    providerMessageId: 'current-provider-id',
    preferenceVersion: 0,
  });
  const attempts = await pool.query(
    'SELECT attempt_no, outcome FROM provider_attempts ORDER BY attempt_no',
  );
  assert.deepEqual(attempts.rows, [
    { attempt_no: 1, outcome: 'lease_expired_unknown' },
    { attempt_no: 2, outcome: 'provider_accepted' },
  ]);
});

test('scheduling prevents early leases and unclaimed expired work becomes terminal', async () => {
  await submit('scheduled-request-0001', {
    channels: ['push'], scheduledAtMs: 5_000, expiresAtMs: 10_000,
  });
  assert.equal(await store.claimNext({
    nowMs: 4_999,
    leaseMs: 100,
    crashCooldownMs: 0,
    leaseToken: randomUUID(),
    workerId: 'worker-early',
  }), null);
  assert.ok(await store.claimNext({
    nowMs: 5_000,
    leaseMs: 100,
    crashCooldownMs: 0,
    leaseToken: randomUUID(),
    workerId: 'worker-due',
  }));

  await submit('expired-request-000001', {
    recipientRef: 'recipient-002', channels: ['sms'], scheduledAtMs: 6_000, expiresAtMs: 7_000,
  });
  assert.equal(await store.claimNext({
    nowMs: 7_000,
    leaseMs: 100,
    crashCooldownMs: 0,
    leaseToken: randomUUID(),
    workerId: 'worker-expiry',
  }), null);
  const expired = await pool.query(
    `SELECT delivery.status, delivery.terminal_reason
     FROM notification_deliveries AS delivery
     JOIN notification_intents AS intent ON intent.id = delivery.intent_id
     WHERE intent.idempotency_key = 'expired-request-000001'`,
  );
  assert.deepEqual(expired.rows[0], { status: 'expired', terminal_reason: 'expired_before_claim' });
});

test('preference written after intake is observed before the provider call', async () => {
  const accepted = await submit('late-preference-key-001', {
    notificationClass: 'transactional', channels: ['push'],
  });
  await service.setPreference({
    tenantId: 'tenant-a',
    preference: {
      recipientRef: 'recipient-001',
      channel: 'push',
      notificationClass: 'transactional',
      enabled: false,
    },
  });
  let providerCalls = 0;
  const result = await new NotificationWorker({
    store,
    provider: { async send() { providerCalls += 1; } },
    clock: () => nowMs,
    workerId: 'worker-preference',
  }).runOne();
  assert.equal(result.kind, 'suppressed');
  assert.equal(providerCalls, 0);
  const state = await store.getIntent('tenant-a', accepted.intentId);
  assert.equal(state.deliveries[0].status, 'suppressed');
  assert.equal(state.deliveries[0].preferenceVersion, 1);
});

test('retry receipt preserves backoff and a later accepted provider response', async () => {
  const created = await submit('retry-receipt-key-0001', { channels: ['push'] });
  const responses = [
    { status: 429, code: 'QUOTA_EXCEEDED', providerMessageId: null, retryAfterMs: 30_000 },
    { status: 202, code: null, providerMessageId: 'provider-message-002', retryAfterMs: null },
  ];
  const worker = new NotificationWorker({
    store,
    provider: { async send() { return responses.shift(); } },
    clock: () => nowMs,
    random: () => 0,
    workerId: 'worker-retry',
  });
  assert.deepEqual(await worker.runOne(), { kind: 'retry', attempt: 1, delayMs: 60_000 });
  nowMs = 60_999;
  assert.deepEqual(await worker.runOne(), { kind: 'idle' });
  nowMs = 61_000;
  assert.deepEqual(await worker.runOne(), { kind: 'provider_accepted', attempt: 2 });
  const state = await store.getIntent('tenant-a', created.intentId);
  assert.equal(state.deliveries[0].status, 'provider_accepted');
  const attempts = await pool.query(
    'SELECT attempt_no, outcome, provider_status, retry_at_ms FROM provider_attempts ORDER BY attempt_no',
  );
  assert.deepEqual(attempts.rows.map((row) => ({
    attempt: row.attempt_no,
    outcome: row.outcome,
    status: row.provider_status,
    retryAtMs: row.retry_at_ms === null ? null : Number(row.retry_at_ms),
  })), [
    { attempt: 1, outcome: 'retry_scheduled', status: 429, retryAtMs: 61_000 },
    { attempt: 2, outcome: 'provider_accepted', status: 202, retryAtMs: null },
  ]);
});

test('accepted response without a usable receipt becomes terminal unknown without retry', async () => {
  const created = await submit('unknown-outcome-key-0001', { channels: ['push'] });
  const worker = new NotificationWorker({
    store,
    provider: {
      async send() {
        throw new ProviderProtocolError('accepted response omitted its id', {
          externalOutcomeUnknown: true,
          providerStatus: 202,
        });
      },
    },
    clock: () => nowMs,
    workerId: 'worker-unknown',
  });
  assert.deepEqual(await worker.runOne(), { kind: 'outcome_unknown', attempt: 1 });
  assert.deepEqual(await worker.runOne(), { kind: 'idle' });
  const state = await store.getIntent('tenant-a', created.intentId);
  assert.equal(state.deliveries[0].status, 'dead');
  assert.equal(state.deliveries[0].terminalReason, 'provider_outcome_unknown');
  const attempt = await pool.query(
    'SELECT outcome, provider_status FROM provider_attempts WHERE delivery_id = $1',
    [state.deliveries[0].id],
  );
  assert.deepEqual(attempt.rows[0], { outcome: 'provider_outcome_unknown', provider_status: 202 });
});
