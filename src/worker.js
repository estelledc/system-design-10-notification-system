import { randomUUID } from 'node:crypto';
import { boundedIdentifier } from './contracts.js';
import { ProviderNetworkError, ProviderProtocolError, ValidationError } from './errors.js';
import { classifyProviderResult, computeRetryDelayMs, preferenceDecision } from './policy.js';

function safeDuration(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ValidationError(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

export class NotificationWorker {
  constructor({
    store,
    provider,
    clock = Date.now,
    random = Math.random,
    uuid = randomUUID,
    workerId = `worker-${randomUUID()}`,
    leaseMs = 30_000,
    crashCooldownMs = 10_000,
    afterProviderResponse = async () => {},
  }) {
    this.store = store;
    this.provider = provider;
    this.clock = clock;
    this.random = random;
    this.uuid = uuid;
    this.workerId = boundedIdentifier(workerId, 'workerId', { max: 64 });
    this.leaseMs = safeDuration(leaseMs, 'leaseMs', 1);
    this.crashCooldownMs = safeDuration(crashCooldownMs, 'crashCooldownMs', 0);
    this.afterProviderResponse = afterProviderResponse;
  }

  async runOne() {
    const delivery = await this.store.claimNext({
      nowMs: this.clock(),
      leaseMs: this.leaseMs,
      crashCooldownMs: this.crashCooldownMs,
      leaseToken: this.uuid(),
      workerId: this.workerId,
    });
    if (!delivery) return { kind: 'idle' };

    const preference = await this.store.findPreference({
      tenantId: delivery.tenantId,
      recipientRef: delivery.recipientRef,
      channel: delivery.channel,
      notificationClass: delivery.notificationClass,
    });
    const decision = preferenceDecision(delivery.notificationClass, preference);
    if (!decision.enabled) {
      await this.store.completeAttempt({
        deliveryId: delivery.id,
        leaseToken: delivery.leaseToken,
        nowMs: this.clock(),
        nextStatus: 'suppressed',
        outcome: 'suppressed',
        terminalReason: decision.source,
        preferenceVersion: decision.version,
      });
      return { kind: 'suppressed', attempt: delivery.attempts };
    }

    if (this.clock() >= delivery.expiresAtMs) {
      await this.#expire(delivery, decision.version, 'expired_before_provider_call');
      return { kind: 'expired', attempt: delivery.attempts };
    }

    let result;
    try {
      result = await this.provider.send(delivery);
      await this.afterProviderResponse({ delivery, result });
    } catch (error) {
      if (error instanceof ProviderProtocolError) {
        if (error.externalOutcomeUnknown) {
          await this.store.completeAttempt({
            deliveryId: delivery.id,
            leaseToken: delivery.leaseToken,
            nowMs: this.clock(),
            nextStatus: 'dead',
            outcome: 'provider_outcome_unknown',
            terminalReason: 'provider_outcome_unknown',
            providerStatus: error.providerStatus,
            providerCode: error.providerCode,
            preferenceVersion: decision.version,
          });
          return { kind: 'outcome_unknown', attempt: delivery.attempts };
        }
        await this.store.completeAttempt({
          deliveryId: delivery.id,
          leaseToken: delivery.leaseToken,
          nowMs: this.clock(),
          nextStatus: 'dead',
          outcome: 'permanent_failure',
          terminalReason: error.code,
          preferenceVersion: decision.version,
        });
        return { kind: 'dead', reason: error.code, attempt: delivery.attempts };
      }
      if (!(error instanceof ProviderNetworkError)) throw error;
      return this.#retryOrStop(delivery, decision.version, {
        status: null,
        code: error.code,
        providerMessageId: null,
        retryAfterMs: null,
      });
    }

    const classification = classifyProviderResult(result);
    if (classification.kind === 'accepted') {
      await this.store.completeAttempt({
        deliveryId: delivery.id,
        leaseToken: delivery.leaseToken,
        nowMs: this.clock(),
        nextStatus: 'provider_accepted',
        outcome: 'provider_accepted',
        providerStatus: result.status,
        providerCode: result.code,
        providerMessageId: result.providerMessageId,
        preferenceVersion: decision.version,
      });
      return { kind: 'provider_accepted', attempt: delivery.attempts };
    }
    if (classification.kind === 'retry') return this.#retryOrStop(delivery, decision.version, result);

    await this.store.completeAttempt({
      deliveryId: delivery.id,
      leaseToken: delivery.leaseToken,
      nowMs: this.clock(),
      nextStatus: 'dead',
      outcome: 'permanent_failure',
      terminalReason: classification.reason,
      providerStatus: result.status,
      providerCode: result.code,
      preferenceVersion: decision.version,
    });
    return { kind: 'dead', reason: classification.reason, attempt: delivery.attempts };
  }

  async #retryOrStop(delivery, preferenceVersion, result) {
    const nowMs = this.clock();
    if (delivery.attempts >= delivery.maxAttempts) {
      await this.store.completeAttempt({
        deliveryId: delivery.id,
        leaseToken: delivery.leaseToken,
        nowMs,
        nextStatus: 'dead',
        outcome: 'attempts_exhausted',
        terminalReason: 'attempt_budget_exhausted',
        providerStatus: result.status,
        providerCode: result.code,
        preferenceVersion,
      });
      return { kind: 'dead', reason: 'attempt_budget_exhausted', attempt: delivery.attempts };
    }
    const delayMs = computeRetryDelayMs({
      attempt: delivery.attempts,
      status: result.status,
      retryAfterMs: result.retryAfterMs,
      random: this.random,
    });
    const availableAtMs = nowMs + delayMs;
    if (availableAtMs >= delivery.expiresAtMs) {
      await this.#expire(delivery, preferenceVersion, 'expired_before_retry', result);
      return { kind: 'expired', attempt: delivery.attempts };
    }
    await this.store.completeAttempt({
      deliveryId: delivery.id,
      leaseToken: delivery.leaseToken,
      nowMs,
      nextStatus: 'retry',
      outcome: 'retry_scheduled',
      availableAtMs,
      providerStatus: result.status,
      providerCode: result.code,
      preferenceVersion,
    });
    return { kind: 'retry', attempt: delivery.attempts, delayMs };
  }

  async #expire(delivery, preferenceVersion, reason, result = {}) {
    await this.store.completeAttempt({
      deliveryId: delivery.id,
      leaseToken: delivery.leaseToken,
      nowMs: this.clock(),
      nextStatus: 'expired',
      outcome: 'expired',
      terminalReason: reason,
      providerStatus: result.status,
      providerCode: result.code,
      preferenceVersion,
    });
  }
}
