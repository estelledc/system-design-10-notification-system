import { ValidationError } from './errors.js';

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const invalidRecipientCodes = new Set(['ExpiredToken', 'UNREGISTERED', 'Unregistered', 'invalid_recipient']);

export function preferenceDecision(notificationClass, preference) {
  if (preference) return { enabled: preference.enabled, version: preference.version, source: 'explicit' };
  if (notificationClass === 'marketing') return { enabled: false, version: 0, source: 'default_deny' };
  if (notificationClass === 'transactional') return { enabled: true, version: 0, source: 'default_allow' };
  throw new ValidationError('notification class is unsupported');
}

export function classifyProviderResult({ status, code }) {
  if (Number.isInteger(status) && status >= 200 && status < 300) return { kind: 'accepted', reason: 'provider_accepted' };
  if (status === 404 || status === 410 || invalidRecipientCodes.has(code)) {
    return { kind: 'permanent', reason: 'invalid_recipient' };
  }
  if (retryableStatuses.has(status)) return { kind: 'retry', reason: `provider_${status}` };
  if (status === null || status === undefined) return { kind: 'retry', reason: 'provider_network_error' };
  return { kind: 'permanent', reason: `provider_${status}` };
}

export function parseRetryAfter(value, nowMs, capMs = 3_600_000) {
  if (value === null || value === undefined || value === '') return null;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1_000, capMs);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(Math.max(0, timestamp - nowMs), capMs);
}

export function computeRetryDelayMs({ attempt, status, retryAfterMs, random = Math.random, capMs = 3_600_000 }) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new ValidationError('attempt must be a positive integer');
  const baseMs = status === 429 ? 60_000 : 10_000;
  const exponential = Math.min(baseMs * (2 ** Math.min(attempt - 1, 10)), capMs);
  const jittered = Math.min(Math.round(exponential * (1 + random())), capMs);
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), capMs);
}
