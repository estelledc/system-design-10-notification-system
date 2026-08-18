import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NotificationService,
  NotificationWorker,
  ProviderNetworkError,
  ProviderProtocolError,
  createDefaultTemplateRegistry,
} from '../../src/index.js';

function uuidSequence() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(value += 1).padStart(12, '0')}`;
}

test('service freezes rendered channel payloads and a canonical request digest', async () => {
  let accepted;
  const store = {
    async acceptIntent(input) {
      accepted = input;
      return {
        created: true,
        intent: input,
        deliveries: input.deliveries.map((delivery) => ({ ...delivery, status: 'pending', attempts: 0 })),
      };
    },
  };
  const service = new NotificationService({
    store,
    templates: createDefaultTemplateRegistry(),
    clock: () => 1_000,
    uuid: uuidSequence(),
  });
  const result = await service.submit({
    tenantId: 'tenant-a',
    idempotencyKey: 'request-key-00000001',
    request: {
      recipientRef: 'recipient-001',
      notificationClass: 'transactional',
      templateId: 'account-alert',
      templateVersion: 1,
      variables: { title: 'Alert', body: 'Changed' },
      channels: ['sms', 'push'],
      expiresAtMs: 10_000,
    },
  });
  assert.equal(result.created, true);
  assert.deepEqual(accepted.deliveries.map((item) => item.channel), ['push', 'sms']);
  assert.equal(accepted.requestDigest.length, 64);
  assert.deepEqual(accepted.deliveries[0].payload, { title: 'Alert', body: 'Changed' });
});

class WorkerStore {
  constructor(delivery, preference = null) {
    this.delivery = delivery;
    this.preference = preference;
    this.completions = [];
  }

  async claimNext(input) {
    if (!this.delivery) return null;
    const claimed = { ...this.delivery, leaseToken: input.leaseToken, leaseOwner: input.workerId };
    this.delivery = null;
    return claimed;
  }

  async findPreference() {
    return this.preference;
  }

  async completeAttempt(input) {
    this.completions.push(input);
  }
}

function delivery(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tenant-a',
    recipientRef: 'recipient-001',
    notificationClass: 'transactional',
    channel: 'push',
    payload: { title: 'Alert', body: 'Changed' },
    expiresAtMs: 1_000_000,
    attempts: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

function worker(store, provider, options = {}) {
  return new NotificationWorker({
    store,
    provider,
    clock: () => 10_000,
    random: () => 0,
    uuid: () => '22222222-2222-4222-8222-222222222222',
    workerId: 'worker-test',
    ...options,
  });
}

test('marketing default deny suppresses before the provider call', async () => {
  const store = new WorkerStore(delivery({ notificationClass: 'marketing' }));
  let calls = 0;
  const result = await worker(store, { async send() { calls += 1; } }).runOne();
  assert.equal(result.kind, 'suppressed');
  assert.equal(calls, 0);
  assert.equal(store.completions[0].nextStatus, 'suppressed');
  assert.equal(store.completions[0].preferenceVersion, 0);
});

test('transactional default allow records provider acceptance without claiming device delivery', async () => {
  const store = new WorkerStore(delivery());
  const result = await worker(store, {
    async send() {
      return { status: 202, code: null, providerMessageId: 'provider-001', retryAfterMs: null };
    },
  }).runOne();
  assert.equal(result.kind, 'provider_accepted');
  assert.equal(store.completions[0].nextStatus, 'provider_accepted');
  assert.equal(store.completions[0].outcome, 'provider_accepted');
});

test('429 schedules a bounded retry and attempt exhaustion becomes dead', async () => {
  const retryStore = new WorkerStore(delivery());
  const retry = await worker(retryStore, {
    async send() {
      return { status: 429, code: 'QUOTA_EXCEEDED', providerMessageId: null, retryAfterMs: 30_000 };
    },
  }).runOne();
  assert.deepEqual(retry, { kind: 'retry', attempt: 1, delayMs: 60_000 });
  assert.equal(retryStore.completions[0].availableAtMs, 70_000);

  const exhaustedStore = new WorkerStore(delivery({ attempts: 5 }));
  const exhausted = await worker(exhaustedStore, {
    async send() { throw new ProviderNetworkError(new Error('reset')); },
  }).runOne();
  assert.equal(exhausted.kind, 'dead');
  assert.equal(exhaustedStore.completions[0].outcome, 'attempts_exhausted');
});

test('retry beyond expiry becomes expired and pre-call provider protocol violations are permanent', async () => {
  const expiringStore = new WorkerStore(delivery({ expiresAtMs: 15_000 }));
  const expired = await worker(expiringStore, {
    async send() {
      return { status: 503, code: 'UNAVAILABLE', providerMessageId: null, retryAfterMs: null };
    },
  }).runOne();
  assert.equal(expired.kind, 'expired');
  assert.equal(expiringStore.completions[0].terminalReason, 'expired_before_retry');

  const protocolStore = new WorkerStore(delivery());
  const dead = await worker(protocolStore, {
    async send() { throw new ProviderProtocolError(); },
  }).runOne();
  assert.equal(dead.kind, 'dead');
  assert.equal(protocolStore.completions[0].terminalReason, 'provider_protocol_error');
});

test('an invalid accepted receipt stops without retry and preserves outcome uncertainty', async () => {
  const store = new WorkerStore(delivery());
  const result = await worker(store, {
    async send() {
      throw new ProviderProtocolError('accepted response omitted its id', {
        externalOutcomeUnknown: true,
        providerStatus: 202,
      });
    },
  }).runOne();
  assert.deepEqual(result, { kind: 'outcome_unknown', attempt: 1 });
  assert.equal(store.completions[0].nextStatus, 'dead');
  assert.equal(store.completions[0].outcome, 'provider_outcome_unknown');
  assert.equal(store.completions[0].terminalReason, 'provider_outcome_unknown');
  assert.equal(store.completions[0].providerStatus, 202);
});

test('worker configuration is fail-closed before claiming queue work', () => {
  const store = new WorkerStore(delivery());
  const provider = { async send() {} };
  assert.throws(() => worker(store, provider, { leaseMs: Number.NaN }));
  assert.throws(() => worker(store, provider, { leaseMs: 0 }));
  assert.throws(() => worker(store, provider, { crashCooldownMs: -1 }));
  assert.throws(() => worker(store, provider, { workerId: 'worker id with spaces' }));
  assert.throws(() => worker(store, provider, { workerId: `worker-${'x'.repeat(64)}` }));
});
