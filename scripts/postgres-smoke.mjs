import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as scheduleTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  NotificationService,
  PostgresNotificationStore,
  createDefaultTemplateRegistry,
} from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required for the PostgreSQL runtime smoke');

const apiToken = 'runtime-api-token-000001';
const providerToken = 'runtime-provider-token-001';
const recipientRef = 'runtime-recipient-001';
const title = 'Runtime alert';
const body = 'Crash-window evidence';
const identities = [
  apiToken,
  providerToken,
  recipientRef,
  title,
  body,
  'runtime-idempotent-key-001',
  'runtime-nonidempotent-key-001',
  'runtime-marketing-key-0001',
];

function captureChild(args, environment) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const deadline = new Promise((resolve, reject) => {
    timeout = scheduleTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

async function waitForExit(processRecord, timeoutMs = 10_000) {
  return withTimeout(
    once(processRecord.child, 'exit'),
    timeoutMs,
    'child process exit timed out',
  );
}

async function startApi() {
  const processRecord = captureChild(['src/main.js', 'serve'], {
    AUTH_TOKENS_JSON: JSON.stringify([{ token: apiToken, tenantId: 'tenant-runtime' }]),
    DATABASE_URL: databaseUrl,
    PORT: '0',
  });
  const port = await withTimeout(
    new Promise((resolve, reject) => {
      const inspect = (chunk) => {
        for (const line of chunk.split('\n')) {
          if (!line.includes('api_listening')) continue;
          resolve(JSON.parse(line).port);
        }
      };
      processRecord.child.stdout.on('data', inspect);
      processRecord.child.once('exit', (code, signal) => {
        reject(new Error(`API exited before listening: code=${code} signal=${signal}`));
      });
    }),
    10_000,
    'API start timed out',
  );
  return { ...processRecord, port };
}

async function stopApi(processRecord) {
  const exit = waitForExit(processRecord);
  processRecord.child.kill('SIGTERM');
  const [code, signal] = await exit;
  assert.equal(code, 0);
  assert.equal(signal, null);
}

async function runWorker({ endpoint, crash, name }) {
  const origin = new URL(endpoint).origin;
  const processRecord = captureChild(['src/main.js', 'work-once'], {
    ALLOWED_TEST_PROVIDER_ORIGINS_JSON: JSON.stringify([origin]),
    CRASH_AFTER_PROVIDER_ACCEPTED: crash ? '1' : '0',
    CRASH_COOLDOWN_MS: '0',
    DATABASE_URL: databaseUrl,
    LEASE_MS: '250',
    NODE_ENV: 'test',
    PROVIDER_BEARER_TOKEN: providerToken,
    PROVIDER_URLS_JSON: JSON.stringify({ push: endpoint }),
    WORKER_ID: name,
  });
  const [code, signal] = await waitForExit(processRecord);
  return { ...processRecord, code, signal };
}

async function waitForLease(pool, intentId) {
  const result = await pool.query(
    'SELECT leased_until_ms FROM notification_deliveries WHERE intent_id = $1',
    [intentId],
  );
  assert.ok(result.rows[0]?.leased_until_ms);
  const remaining = Number(result.rows[0].leased_until_ms) - Date.now();
  if (remaining >= 0) await delay(remaining + 25);
}

const provider = {
  requests: { idempotent: 0, nonidempotent: 0 },
  effects: { idempotent: 0, nonidempotent: 0 },
  idsByDelivery: new Map(),
};
const providerServer = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${providerToken}`);
  const mode = request.url === '/idempotent' ? 'idempotent' : 'nonidempotent';
  assert.ok(request.url === '/idempotent' || request.url === '/nonidempotent');
  const deliveryKey = request.headers['x-delivery-key'];
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const payload = JSON.parse(raw);
  assert.equal(payload.deliveryId, deliveryKey);
  provider.requests[mode] += 1;

  let providerMessageId;
  if (mode === 'idempotent') {
    providerMessageId = provider.idsByDelivery.get(deliveryKey);
    if (!providerMessageId) {
      provider.effects.idempotent += 1;
      providerMessageId = `idempotent-effect-${provider.effects.idempotent}`;
      provider.idsByDelivery.set(deliveryKey, providerMessageId);
    }
  } else {
    provider.effects.nonidempotent += 1;
    providerMessageId = `nonidempotent-effect-${provider.effects.nonidempotent}`;
  }
  response.writeHead(202, {
    'content-type': 'application/json',
    'x-provider-message-id': providerMessageId,
  });
  response.end('{}');
});
providerServer.listen(0, '127.0.0.1');
await once(providerServer, 'listening');
const providerOrigin = `http://127.0.0.1:${providerServer.address().port}`;

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const store = new PostgresNotificationStore(pool);
await store.migrate();
await pool.query(`TRUNCATE
  provider_attempts,
  notification_preferences,
  notification_deliveries,
  notification_intents`);
const version = await pool.query('SHOW server_version');
const service = new NotificationService({ store, templates: createDefaultTemplateRegistry() });
const childLogs = [];

const api = await startApi();
const intake = await fetch(`http://127.0.0.1:${api.port}/v1/notifications`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiToken}`,
    'content-type': 'application/json',
    'idempotency-key': 'runtime-idempotent-key-001',
  },
  body: JSON.stringify({
    recipientRef,
    notificationClass: 'transactional',
    templateId: 'account-alert',
    templateVersion: 1,
    variables: { title, body },
    channels: ['push'],
    expiresAtMs: Date.now() + 60_000,
  }),
});
assert.equal(intake.status, 201);
const idempotentIntent = await intake.json();
await stopApi(api);
childLogs.push(api.stdout(), api.stderr());

const idempotentCrash = await runWorker({
  endpoint: `${providerOrigin}/idempotent`, crash: true, name: 'worker-idempotent-crash',
});
assert.equal(idempotentCrash.signal, 'SIGKILL');
childLogs.push(idempotentCrash.stdout(), idempotentCrash.stderr());
await waitForLease(pool, idempotentIntent.intentId);
const idempotentRecovery = await runWorker({
  endpoint: `${providerOrigin}/idempotent`, crash: false, name: 'worker-idempotent-recovery',
});
assert.equal(idempotentRecovery.code, 0);
childLogs.push(idempotentRecovery.stdout(), idempotentRecovery.stderr());
assert.equal(provider.requests.idempotent, 2);
assert.equal(provider.effects.idempotent, 1);

const nonidempotentIntent = await service.submit({
  tenantId: 'tenant-runtime',
  idempotencyKey: 'runtime-nonidempotent-key-001',
  request: {
    recipientRef,
    notificationClass: 'transactional',
    templateId: 'account-alert',
    templateVersion: 1,
    variables: { title, body },
    channels: ['push'],
    expiresAtMs: Date.now() + 60_000,
  },
});
const nonidempotentCrash = await runWorker({
  endpoint: `${providerOrigin}/nonidempotent`, crash: true, name: 'worker-nonidempotent-crash',
});
assert.equal(nonidempotentCrash.signal, 'SIGKILL');
childLogs.push(nonidempotentCrash.stdout(), nonidempotentCrash.stderr());
await waitForLease(pool, nonidempotentIntent.intentId);
const nonidempotentRecovery = await runWorker({
  endpoint: `${providerOrigin}/nonidempotent`, crash: false, name: 'worker-nonidempotent-recovery',
});
assert.equal(nonidempotentRecovery.code, 0);
childLogs.push(nonidempotentRecovery.stdout(), nonidempotentRecovery.stderr());
assert.equal(provider.requests.nonidempotent, 2);
assert.equal(provider.effects.nonidempotent, 2);

await service.submit({
  tenantId: 'tenant-runtime',
  idempotencyKey: 'runtime-marketing-key-0001',
  request: {
    recipientRef,
    notificationClass: 'marketing',
    templateId: 'account-alert',
    templateVersion: 1,
    variables: { title, body },
    channels: ['push'],
    expiresAtMs: Date.now() + 60_000,
  },
});
const requestsBeforeSuppression = provider.requests.idempotent + provider.requests.nonidempotent;
const suppression = await runWorker({
  endpoint: `${providerOrigin}/idempotent`, crash: false, name: 'worker-marketing-suppression',
});
assert.equal(suppression.code, 0);
assert.match(suppression.stdout(), /"kind":"suppressed"/);
childLogs.push(suppression.stdout(), suppression.stderr());
assert.equal(provider.requests.idempotent + provider.requests.nonidempotent, requestsBeforeSuppression);

const finalStats = await store.stats();
assert.equal(finalStats.intents, 3);
assert.deepEqual(finalStats.deliveries, { provider_accepted: 2, suppressed: 1 });
assert.equal(finalStats.attempts.lease_expired_unknown, 2);
assert.equal(finalStats.attempts.provider_accepted, 2);
assert.equal(finalStats.attempts.suppressed, 1);

const logs = childLogs.join('');
for (const identity of identities) assert.ok(!logs.includes(identity), 'child logs contained request or credential identity');

providerServer.close();
await once(providerServer, 'close');
await pool.end();

process.stdout.write(`${JSON.stringify({
  kind: 'notification_provider_crash_window_receipt',
  node: process.version,
  postgres: version.rows[0].server_version,
  apiIntakePersisted: true,
  forcedTermination: 'SIGKILL',
  recoveredAttemptNumber: 2,
  idempotentProviderRequests: provider.requests.idempotent,
  idempotentProviderEffects: provider.effects.idempotent,
  nonidempotentProviderRequests: provider.requests.nonidempotent,
  nonidempotentProviderEffects: provider.effects.nonidempotent,
  defaultDenyProviderRequests: 0,
  providerAcceptedDeliveries: finalStats.deliveries.provider_accepted,
  deviceDeliveredClaims: 0,
  rawIdentityLogged: false,
  claimBoundary: 'one PostgreSQL service, loopback HTTP provider fixtures, process SIGKILL, and sequential recovery workers; not real APNs/FCM/email/SMS behavior, device delivery, power loss, database failover, or production exactly-once delivery',
})}\n`);
