import { ValidationError } from './errors.js';

export const CHANNELS = Object.freeze(['email', 'push', 'sms']);
export const NOTIFICATION_CLASSES = Object.freeze(['marketing', 'transactional']);

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const variableNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError(`${label} must be a plain object`);
  }
  return value;
}

export function boundedIdentifier(value, label, { min = 1, max = 128 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || !identifierPattern.test(value)) {
    throw new ValidationError(`${label} must be ${min}-${max} safe identifier characters`);
  }
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeVariables(value) {
  const input = plainObject(value, 'variables');
  const entries = Object.entries(input);
  if (entries.length > 20) throw new ValidationError('variables may contain at most 20 fields');
  let totalBytes = 0;
  const normalized = {};
  for (const [key, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!variableNamePattern.test(key) || key.length > 64) throw new ValidationError('variable names are invalid');
    if (typeof raw !== 'string' || raw.length > 1_024) throw new ValidationError('variable values must be bounded strings');
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(raw);
    normalized[key] = raw;
  }
  if (totalBytes > 8_192) throw new ValidationError('variables exceed the 8 KiB request limit');
  return normalized;
}

export function normalizeIdempotencyKey(value) {
  return boundedIdentifier(value, 'idempotency key', { min: 16, max: 128 });
}

export function normalizeTenantId(value) {
  return boundedIdentifier(value, 'tenantId', { max: 64 });
}

export function normalizeNotificationRequest(value, { nowMs }) {
  const input = plainObject(value, 'request');
  const recipientRef = boundedIdentifier(input.recipientRef, 'recipientRef');
  const notificationClass = input.notificationClass;
  if (!NOTIFICATION_CLASSES.includes(notificationClass)) {
    throw new ValidationError('notificationClass must be marketing or transactional');
  }
  const templateId = boundedIdentifier(input.templateId, 'templateId', { max: 64 });
  const templateVersion = integer(input.templateVersion, 'templateVersion', { min: 1, max: 1_000_000 });
  if (!Array.isArray(input.channels) || input.channels.length < 1 || input.channels.length > CHANNELS.length) {
    throw new ValidationError('channels must contain one to three supported channels');
  }
  const channels = [...new Set(input.channels)];
  if (channels.length !== input.channels.length || channels.some((channel) => !CHANNELS.includes(channel))) {
    throw new ValidationError('channels must be unique supported channel names');
  }
  channels.sort();
  const scheduledAtMs = input.scheduledAtMs === undefined
    ? nowMs
    : integer(input.scheduledAtMs, 'scheduledAtMs');
  const expiresAtMs = integer(input.expiresAtMs, 'expiresAtMs');
  if (expiresAtMs <= scheduledAtMs || expiresAtMs <= nowMs) {
    throw new ValidationError('expiresAtMs must be later than both the schedule and current time');
  }
  const priority = input.priority === undefined
    ? 5
    : integer(input.priority, 'priority', { min: 0, max: 9 });

  return {
    recipientRef,
    notificationClass,
    templateId,
    templateVersion,
    variables: normalizeVariables(input.variables ?? {}),
    channels,
    scheduledAtMs,
    expiresAtMs,
    priority,
  };
}

export function normalizePreference(value) {
  const input = plainObject(value, 'preference');
  const recipientRef = boundedIdentifier(input.recipientRef, 'recipientRef');
  if (!CHANNELS.includes(input.channel)) throw new ValidationError('preference channel is unsupported');
  if (!NOTIFICATION_CLASSES.includes(input.notificationClass)) {
    throw new ValidationError('preference notificationClass is unsupported');
  }
  if (typeof input.enabled !== 'boolean') throw new ValidationError('preference enabled must be boolean');
  return {
    recipientRef,
    channel: input.channel,
    notificationClass: input.notificationClass,
    enabled: input.enabled,
  };
}
