import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './canonical.js';
import {
  normalizeIdempotencyKey,
  normalizeNotificationRequest,
  normalizePreference,
  normalizeTenantId,
} from './contracts.js';

function publicResult(result) {
  return {
    created: result.created,
    intentId: result.intent.id,
    scheduledAtMs: result.intent.scheduledAtMs,
    expiresAtMs: result.intent.expiresAtMs,
    deliveries: result.deliveries.map((delivery) => ({
      id: delivery.id,
      channel: delivery.channel,
      status: delivery.status,
      attempts: delivery.attempts,
      terminalReason: delivery.terminalReason,
    })),
  };
}

export class NotificationService {
  constructor({ store, templates, clock = Date.now, uuid = randomUUID, maxAttempts = 5 }) {
    this.store = store;
    this.templates = templates;
    this.clock = clock;
    this.uuid = uuid;
    this.maxAttempts = maxAttempts;
  }

  async submit({ tenantId, idempotencyKey, request }) {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const nowMs = this.clock();
    const normalized = normalizeNotificationRequest(request, { nowMs });
    const requestDigest = sha256(canonicalJson(normalized));
    const id = this.uuid();
    const deliveries = normalized.channels.map((channel) => {
      const payload = this.templates.render(
        normalized.templateId,
        normalized.templateVersion,
        channel,
        normalized.variables,
      );
      return {
        id: this.uuid(),
        channel,
        payload,
        payloadDigest: sha256(payload),
        maxAttempts: this.maxAttempts,
      };
    });
    const result = await this.store.acceptIntent({
      id,
      tenantId: normalizedTenantId,
      idempotencyKey: normalizedKey,
      requestDigest,
      ...normalized,
      createdAtMs: nowMs,
      deliveries,
    });
    return publicResult(result);
  }

  async setPreference({ tenantId, preference }) {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const normalized = normalizePreference(preference);
    return this.store.setPreference({
      tenantId: normalizedTenantId,
      ...normalized,
      updatedAtMs: this.clock(),
    });
  }

  async getIntent({ tenantId, intentId }) {
    const result = await this.store.getIntent(normalizeTenantId(tenantId), intentId);
    return publicResult({ created: false, ...result });
  }
}
