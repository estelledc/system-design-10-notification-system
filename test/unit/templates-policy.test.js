import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ValidationError,
  classifyProviderResult,
  computeRetryDelayMs,
  createDefaultTemplateRegistry,
  parseRetryAfter,
  preferenceDecision,
} from '../../src/index.js';

test('registered template renders deterministic channel payloads', () => {
  const templates = createDefaultTemplateRegistry();
  assert.deepEqual(
    templates.render('account-alert', 1, 'push', { body: 'Changed', title: 'Alert' }),
    { title: 'Alert', body: 'Changed' },
  );
  assert.deepEqual(
    templates.render('account-alert', 1, 'sms', { title: 'Alert', body: 'Changed' }),
    { text: 'Alert: Changed' },
  );
});

test('template schema rejects missing, extra, and oversized values', () => {
  const templates = createDefaultTemplateRegistry();
  assert.throws(
    () => templates.render('account-alert', 1, 'push', { title: 'Alert' }),
    ValidationError,
  );
  assert.throws(
    () => templates.render('account-alert', 1, 'push', { title: 'Alert', body: 'Changed', extra: 'x' }),
    ValidationError,
  );
  assert.throws(
    () => templates.render('account-alert', 1, 'push', { title: 'Alert', body: 'x'.repeat(5_000) }),
    ValidationError,
  );
});

test('preference defaults distinguish marketing from transactional notifications', () => {
  assert.deepEqual(preferenceDecision('marketing', null), {
    enabled: false, version: 0, source: 'default_deny',
  });
  assert.deepEqual(preferenceDecision('transactional', null), {
    enabled: true, version: 0, source: 'default_allow',
  });
  assert.deepEqual(preferenceDecision('transactional', { enabled: false, version: 7 }), {
    enabled: false, version: 7, source: 'explicit',
  });
});

test('provider classification separates acceptance, retry, invalid recipient, and permanent failure', () => {
  assert.equal(classifyProviderResult({ status: 202 }).kind, 'accepted');
  assert.equal(classifyProviderResult({ status: 429 }).kind, 'retry');
  assert.equal(classifyProviderResult({ status: 503 }).kind, 'retry');
  assert.deepEqual(classifyProviderResult({ status: 410, code: 'Unregistered' }), {
    kind: 'permanent', reason: 'invalid_recipient',
  });
  assert.deepEqual(classifyProviderResult({ status: 400, code: 'BadPayload' }), {
    kind: 'permanent', reason: 'provider_400',
  });
});

test('Retry-After and exponential backoff are bounded and never retry immediately', () => {
  assert.equal(parseRetryAfter('90', 1_000), 90_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:12 GMT', 10_000), 2_000);
  assert.equal(parseRetryAfter('invalid', 1_000), null);
  assert.equal(computeRetryDelayMs({ attempt: 1, status: 503, random: () => 0 }), 10_000);
  assert.equal(computeRetryDelayMs({ attempt: 1, status: 429, random: () => 0 }), 60_000);
  assert.equal(computeRetryDelayMs({
    attempt: 2, status: 503, retryAfterMs: 45_000, random: () => 0,
  }), 45_000);
});
