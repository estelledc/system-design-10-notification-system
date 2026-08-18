import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ValidationError,
  canonicalJson,
  normalizeIdempotencyKey,
  normalizeNotificationRequest,
  sha256,
} from '../../src/index.js';

test('canonical JSON and digest ignore object insertion order but preserve array order', () => {
  const left = { z: 1, nested: { b: 'two', a: 'one' }, list: ['a', 'b'] };
  const right = { list: ['a', 'b'], nested: { a: 'one', b: 'two' }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha256(left), sha256(right));
  assert.notEqual(sha256(left), sha256({ ...right, list: ['b', 'a'] }));
});

test('notification contract canonicalizes channels and variables while preserving schedule', () => {
  const result = normalizeNotificationRequest({
    recipientRef: 'recipient-001',
    notificationClass: 'transactional',
    templateId: 'account-alert',
    templateVersion: 1,
    variables: { title: 'Alert', body: 'Changed' },
    channels: ['sms', 'push', 'email'],
    scheduledAtMs: 2_000,
    expiresAtMs: 5_000,
    priority: 9,
  }, { nowMs: 1_000 });
  assert.deepEqual(result.channels, ['email', 'push', 'sms']);
  assert.deepEqual(Object.keys(result.variables), ['body', 'title']);
  assert.equal(result.priority, 9);
  assert.equal(result.scheduledAtMs, 2_000);
});

test('notification contract rejects duplicate channels, expired work, and unsupported values', () => {
  const base = {
    recipientRef: 'recipient-001',
    notificationClass: 'marketing',
    templateId: 'account-alert',
    templateVersion: 1,
    variables: { title: 'Alert', body: 'Changed' },
    channels: ['push'],
    scheduledAtMs: 2_000,
    expiresAtMs: 5_000,
  };
  assert.throws(
    () => normalizeNotificationRequest({ ...base, channels: ['push', 'push'] }, { nowMs: 1_000 }),
    ValidationError,
  );
  assert.throws(
    () => normalizeNotificationRequest({ ...base, expiresAtMs: 1_000 }, { nowMs: 1_000 }),
    ValidationError,
  );
  assert.throws(
    () => normalizeNotificationRequest({ ...base, notificationClass: 'urgent' }, { nowMs: 1_000 }),
    ValidationError,
  );
});

test('idempotency keys are bounded safe identifiers', () => {
  assert.equal(normalizeIdempotencyKey('request-key-00000001'), 'request-key-00000001');
  assert.throws(() => normalizeIdempotencyKey('short'), ValidationError);
  assert.throws(() => normalizeIdempotencyKey('request key with spaces'), ValidationError);
});
