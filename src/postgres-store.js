import {
  DependencyError,
  LeaseLostError,
  NotFoundError,
  RequestConflictError,
  ValidationError,
} from './errors.js';
import { SCHEMA_SQL } from './schema.js';

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function mapIntent(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    recipientRef: row.recipient_ref,
    notificationClass: row.notification_class,
    templateId: row.template_id,
    templateVersion: row.template_version,
    variables: row.variables,
    scheduledAtMs: Number(row.scheduled_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    priority: row.priority,
    createdAtMs: Number(row.created_at_ms),
  };
}

function mapDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    intentId: row.intent_id,
    tenantId: row.tenant_id,
    recipientRef: row.recipient_ref,
    notificationClass: row.notification_class,
    channel: row.channel,
    payload: row.payload,
    payloadDigest: row.payload_digest,
    status: row.status,
    availableAtMs: Number(row.available_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leasedUntilMs: numberOrNull(row.leased_until_ms),
    providerMessageId: row.provider_message_id,
    providerAcceptedAtMs: numberOrNull(row.provider_accepted_at_ms),
    terminalReason: row.terminal_reason,
    preferenceVersion: numberOrNull(row.preference_version),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function dependencyFailure(error) {
  if (
    error instanceof DependencyError
    || error instanceof LeaseLostError
    || error instanceof NotFoundError
    || error instanceof RequestConflictError
    || error instanceof ValidationError
  ) return error;
  return new DependencyError('PostgreSQL operation failed', error);
}

const completionStates = new Set(['provider_accepted', 'retry', 'suppressed', 'expired', 'dead']);
const attemptOutcomes = new Set([
  'provider_accepted',
  'retry_scheduled',
  'suppressed',
  'expired',
  'permanent_failure',
  'attempts_exhausted',
  'provider_outcome_unknown',
]);

export class PostgresNotificationStore {
  constructor(pool) {
    this.pool = pool;
  }

  async migrate() {
    try {
      await this.pool.query(SCHEMA_SQL);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async ping() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async acceptIntent(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO notification_intents (
          id, tenant_id, idempotency_key, request_digest, recipient_ref, notification_class,
          template_id, template_version, variables, scheduled_at_ms, expires_at_ms, priority, created_at_ms
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING *`,
        [
          input.id,
          input.tenantId,
          input.idempotencyKey,
          input.requestDigest,
          input.recipientRef,
          input.notificationClass,
          input.templateId,
          input.templateVersion,
          JSON.stringify(input.variables),
          input.scheduledAtMs,
          input.expiresAtMs,
          input.priority,
          input.createdAtMs,
        ],
      );

      if (inserted.rowCount === 0) {
        const replay = await client.query(
          'SELECT * FROM notification_intents WHERE tenant_id = $1 AND idempotency_key = $2',
          [input.tenantId, input.idempotencyKey],
        );
        const intent = replay.rows[0];
        if (!intent) throw new DependencyError('Conflicting intent was not visible after unique-key wait');
        if (intent.request_digest !== input.requestDigest) throw new RequestConflictError();
        const deliveries = await client.query(
          'SELECT * FROM notification_deliveries WHERE intent_id = $1 ORDER BY channel',
          [intent.id],
        );
        await client.query('COMMIT');
        return { created: false, intent: mapIntent(intent), deliveries: deliveries.rows.map(mapDelivery) };
      }

      for (const delivery of input.deliveries) {
        await client.query(
          `INSERT INTO notification_deliveries (
            id, intent_id, channel, payload, payload_digest, available_at_ms, expires_at_ms,
            priority, max_attempts, created_at_ms, updated_at_ms
          ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $10)`,
          [
            delivery.id,
            input.id,
            delivery.channel,
            JSON.stringify(delivery.payload),
            delivery.payloadDigest,
            input.scheduledAtMs,
            input.expiresAtMs,
            input.priority,
            delivery.maxAttempts,
            input.createdAtMs,
          ],
        );
      }
      const deliveries = await client.query(
        'SELECT * FROM notification_deliveries WHERE intent_id = $1 ORDER BY channel',
        [input.id],
      );
      await client.query('COMMIT');
      return { created: true, intent: mapIntent(inserted.rows[0]), deliveries: deliveries.rows.map(mapDelivery) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async setPreference(input) {
    try {
      const result = await this.pool.query(
        `INSERT INTO notification_preferences (
          tenant_id, recipient_ref, channel, notification_class, enabled, updated_at_ms
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, recipient_ref, channel, notification_class)
        DO UPDATE SET
          enabled = EXCLUDED.enabled,
          version = notification_preferences.version + 1,
          updated_at_ms = EXCLUDED.updated_at_ms
        RETURNING enabled, version, updated_at_ms`,
        [
          input.tenantId,
          input.recipientRef,
          input.channel,
          input.notificationClass,
          input.enabled,
          input.updatedAtMs,
        ],
      );
      return {
        enabled: result.rows[0].enabled,
        version: Number(result.rows[0].version),
        updatedAtMs: Number(result.rows[0].updated_at_ms),
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async findPreference({ tenantId, recipientRef, channel, notificationClass }) {
    try {
      const result = await this.pool.query(
        `SELECT enabled, version, updated_at_ms
         FROM notification_preferences
         WHERE tenant_id = $1 AND recipient_ref = $2 AND channel = $3 AND notification_class = $4`,
        [tenantId, recipientRef, channel, notificationClass],
      );
      if (!result.rows[0]) return null;
      return {
        enabled: result.rows[0].enabled,
        version: Number(result.rows[0].version),
        updatedAtMs: Number(result.rows[0].updated_at_ms),
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async claimNext({ nowMs, leaseMs, crashCooldownMs, leaseToken, workerId }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'expired', terminal_reason = 'expired_before_claim', updated_at_ms = $1
         WHERE status IN ('pending', 'retry') AND expires_at_ms <= $1`,
        [nowMs],
      );
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'dead', terminal_reason = 'attempt_budget_exhausted', updated_at_ms = $1
         WHERE status IN ('pending', 'retry') AND attempts >= max_attempts`,
        [nowMs],
      );
      await client.query(
        `WITH expired AS (
          UPDATE notification_deliveries
          SET
            status = CASE
              WHEN expires_at_ms <= $1::bigint + $2::bigint THEN 'expired'
              WHEN attempts >= max_attempts THEN 'dead'
              ELSE 'retry'
            END,
            available_at_ms = GREATEST(available_at_ms, $1::bigint + $2::bigint),
            terminal_reason = CASE
              WHEN expires_at_ms <= $1::bigint + $2::bigint THEN 'expired_after_unknown_attempt'
              WHEN attempts >= max_attempts THEN 'attempt_budget_after_unknown_attempt'
              ELSE NULL
            END,
            lease_token = NULL,
            lease_owner = NULL,
            leased_until_ms = NULL,
            updated_at_ms = $1
          WHERE status = 'leased' AND leased_until_ms <= $1
          RETURNING id, attempts
        )
        UPDATE provider_attempts AS attempt
        SET outcome = 'lease_expired_unknown', finished_at_ms = $1
        FROM expired
        WHERE attempt.delivery_id = expired.id
          AND attempt.attempt_no = expired.attempts
          AND attempt.outcome = 'started'`,
        [nowMs, crashCooldownMs],
      );

      const candidate = await client.query(
        `SELECT delivery.id
         FROM notification_deliveries AS delivery
         WHERE delivery.status IN ('pending', 'retry')
           AND delivery.available_at_ms <= $1
           AND delivery.expires_at_ms > $1
           AND delivery.attempts < delivery.max_attempts
         ORDER BY delivery.priority DESC, delivery.available_at_ms, delivery.id
         FOR UPDATE OF delivery SKIP LOCKED
         LIMIT 1`,
        [nowMs],
      );
      if (!candidate.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const leased = await client.query(
        `UPDATE notification_deliveries
         SET
           status = 'leased',
           attempts = attempts + 1,
           lease_token = $2,
           lease_owner = $3,
           leased_until_ms = $1::bigint + $4::bigint,
           terminal_reason = NULL,
           updated_at_ms = $1
         WHERE id = $5
         RETURNING *`,
        [nowMs, leaseToken, workerId, leaseMs, candidate.rows[0].id],
      );
      const delivery = leased.rows[0];
      await client.query(
        `INSERT INTO provider_attempts (
          delivery_id, attempt_no, lease_token, started_at_ms, outcome
        ) VALUES ($1, $2, $3, $4, 'started')`,
        [delivery.id, delivery.attempts, leaseToken, nowMs],
      );
      const joined = await client.query(
        `SELECT delivery.*, intent.tenant_id, intent.recipient_ref, intent.notification_class
         FROM notification_deliveries AS delivery
         JOIN notification_intents AS intent ON intent.id = delivery.intent_id
         WHERE delivery.id = $1`,
        [delivery.id],
      );
      await client.query('COMMIT');
      return mapDelivery(joined.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async completeAttempt(input) {
    if (!completionStates.has(input.nextStatus) || !attemptOutcomes.has(input.outcome)) {
      throw new ValidationError('Attempt completion state is invalid');
    }
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE notification_deliveries
         SET
           status = $4,
           available_at_ms = COALESCE($5, available_at_ms),
           lease_token = NULL,
           lease_owner = NULL,
           leased_until_ms = NULL,
           provider_message_id = $6,
           provider_accepted_at_ms = $7,
           terminal_reason = $8,
           preference_version = $9,
           updated_at_ms = $3
         WHERE id = $1 AND status = 'leased' AND lease_token = $2
         RETURNING attempts`,
        [
          input.deliveryId,
          input.leaseToken,
          input.nowMs,
          input.nextStatus,
          input.availableAtMs ?? null,
          input.providerMessageId ?? null,
          input.nextStatus === 'provider_accepted' ? input.nowMs : null,
          input.terminalReason ?? null,
          input.preferenceVersion ?? null,
        ],
      );
      if (updated.rowCount !== 1) throw new LeaseLostError();
      const attempt = await client.query(
        `UPDATE provider_attempts
         SET
           finished_at_ms = $4,
           outcome = $5,
           provider_status = $6,
           provider_code = $7,
           provider_message_id = $8,
           retry_at_ms = $9,
           preference_version = $10
         WHERE delivery_id = $1 AND attempt_no = $2 AND lease_token = $3 AND outcome = 'started'`,
        [
          input.deliveryId,
          updated.rows[0].attempts,
          input.leaseToken,
          input.nowMs,
          input.outcome,
          input.providerStatus ?? null,
          input.providerCode ?? null,
          input.providerMessageId ?? null,
          input.availableAtMs ?? null,
          input.preferenceVersion ?? null,
        ],
      );
      if (attempt.rowCount !== 1) throw new DependencyError('Current attempt receipt was not writable');
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async getIntent(tenantId, intentId) {
    try {
      const intentResult = await this.pool.query(
        'SELECT * FROM notification_intents WHERE tenant_id = $1 AND id = $2',
        [tenantId, intentId],
      );
      if (!intentResult.rows[0]) throw new NotFoundError();
      const deliveryResult = await this.pool.query(
        'SELECT * FROM notification_deliveries WHERE intent_id = $1 ORDER BY channel',
        [intentId],
      );
      return { intent: mapIntent(intentResult.rows[0]), deliveries: deliveryResult.rows.map(mapDelivery) };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async stats() {
    try {
      const [intents, deliveries, attempts] = await Promise.all([
        this.pool.query('SELECT count(*)::integer AS count FROM notification_intents'),
        this.pool.query('SELECT status, count(*)::integer AS count FROM notification_deliveries GROUP BY status'),
        this.pool.query('SELECT outcome, count(*)::integer AS count FROM provider_attempts GROUP BY outcome'),
      ]);
      return {
        intents: intents.rows[0].count,
        deliveries: Object.fromEntries(deliveries.rows.map((row) => [row.status, row.count])),
        attempts: Object.fromEntries(attempts.rows.map((row) => [row.outcome, row.count])),
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async close() {
    await this.pool.end();
  }

  async #connect() {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw dependencyFailure(error);
    }
  }
}
