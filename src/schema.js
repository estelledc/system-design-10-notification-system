export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_intents (
  id uuid PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  recipient_ref varchar(128) NOT NULL,
  notification_class varchar(16) NOT NULL CHECK (notification_class IN ('marketing', 'transactional')),
  template_id varchar(64) NOT NULL,
  template_version integer NOT NULL CHECK (template_version > 0),
  variables jsonb NOT NULL,
  scheduled_at_ms bigint NOT NULL CHECK (scheduled_at_ms >= 0),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > scheduled_at_ms),
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 9),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  CONSTRAINT notification_intents_tenant_key_uniq UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES notification_intents(id),
  channel varchar(16) NOT NULL CHECK (channel IN ('email', 'push', 'sms')),
  payload jsonb NOT NULL,
  payload_digest char(64) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'leased', 'provider_accepted', 'suppressed', 'expired', 'dead')),
  available_at_ms bigint NOT NULL CHECK (available_at_ms >= 0),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > 0),
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 9),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  lease_token uuid,
  lease_owner varchar(64),
  leased_until_ms bigint,
  provider_message_id varchar(256),
  provider_accepted_at_ms bigint,
  terminal_reason varchar(64),
  preference_version bigint,
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= 0),
  CONSTRAINT notification_deliveries_intent_channel_uniq UNIQUE (intent_id, channel),
  CONSTRAINT notification_deliveries_lease_shape CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND leased_until_ms IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_owner IS NULL AND leased_until_ms IS NULL)
  ),
  CONSTRAINT notification_deliveries_acceptance_shape CHECK (
    (status = 'provider_accepted' AND provider_message_id IS NOT NULL AND provider_accepted_at_ms IS NOT NULL)
    OR (status <> 'provider_accepted' AND provider_message_id IS NULL AND provider_accepted_at_ms IS NULL)
  ),
  CONSTRAINT notification_deliveries_terminal_shape CHECK (
    (status IN ('suppressed', 'expired', 'dead') AND terminal_reason IS NOT NULL)
    OR (status NOT IN ('suppressed', 'expired', 'dead') AND terminal_reason IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  tenant_id varchar(64) NOT NULL,
  recipient_ref varchar(128) NOT NULL,
  channel varchar(16) NOT NULL CHECK (channel IN ('email', 'push', 'sms')),
  notification_class varchar(16) NOT NULL CHECK (notification_class IN ('marketing', 'transactional')),
  enabled boolean NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (tenant_id, recipient_ref, channel, notification_class)
);

CREATE TABLE IF NOT EXISTS provider_attempts (
  delivery_id uuid NOT NULL REFERENCES notification_deliveries(id),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  lease_token uuid NOT NULL,
  started_at_ms bigint NOT NULL CHECK (started_at_ms >= 0),
  finished_at_ms bigint,
  outcome varchar(32) NOT NULL CHECK (outcome IN (
    'started', 'lease_expired_unknown', 'provider_accepted', 'retry_scheduled',
    'suppressed', 'expired', 'permanent_failure', 'attempts_exhausted',
    'provider_outcome_unknown'
  )),
  provider_status integer,
  provider_code varchar(128),
  provider_message_id varchar(256),
  retry_at_ms bigint,
  preference_version bigint,
  PRIMARY KEY (delivery_id, attempt_no),
  CONSTRAINT provider_attempts_finish_shape CHECK (
    (outcome = 'started' AND finished_at_ms IS NULL)
    OR (outcome <> 'started' AND finished_at_ms IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx
  ON notification_deliveries (priority DESC, available_at_ms, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS notification_deliveries_lease_expiry_idx
  ON notification_deliveries (leased_until_ms)
  WHERE status = 'leased';

CREATE INDEX IF NOT EXISTS provider_attempts_started_idx
  ON provider_attempts (started_at_ms)
  WHERE outcome = 'started';
`;
