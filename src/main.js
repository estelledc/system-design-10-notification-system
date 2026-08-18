import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Pool } from 'pg';
import {
  HttpProviderClient,
  NotificationService,
  NotificationWorker,
  PostgresNotificationStore,
  ValidationError,
  createDefaultTemplateRegistry,
  createHttpServer,
  normalizeTenantId,
} from './index.js';

function parseJsonEnvironment(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new ValidationError(`${name} must contain valid JSON`);
  }
}

function parseIntegerEnvironment(name, fallback, { min, max = Number.MAX_SAFE_INTEGER }) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function authTokenMap() {
  const records = parseJsonEnvironment('AUTH_TOKENS_JSON', []);
  if (!Array.isArray(records)) throw new ValidationError('AUTH_TOKENS_JSON must be an array');
  const result = new Map();
  for (const record of records) {
    if (!record || typeof record.token !== 'string' || record.token.length < 16) {
      throw new ValidationError('each auth token must contain at least 16 characters');
    }
    result.set(record.token, normalizeTenantId(record.tenantId));
  }
  return result;
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new ValidationError('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl, max: 20 });
  const store = new PostgresNotificationStore(pool);
  const command = process.argv[2] ?? 'serve';
  let keepPoolOpen = false;
  try {
    await store.migrate();

    if (command === 'migrate') {
      process.stdout.write(`${JSON.stringify({ kind: 'migration_complete' })}\n`);
      return;
    }
    if (command === 'stats') {
      process.stdout.write(`${JSON.stringify({ kind: 'notification_stats', ...(await store.stats()) })}\n`);
      return;
    }
    if (command === 'work-once') {
      const endpoints = parseJsonEnvironment('PROVIDER_URLS_JSON', null);
      const allowedTestOrigins = parseJsonEnvironment('ALLOWED_TEST_PROVIDER_ORIGINS_JSON', []);
      if (!Array.isArray(allowedTestOrigins)) {
        throw new ValidationError('ALLOWED_TEST_PROVIDER_ORIGINS_JSON must be an array');
      }
      const provider = new HttpProviderClient({
        endpoints,
        bearerToken: process.env.PROVIDER_BEARER_TOKEN,
        nodeEnv: process.env.NODE_ENV,
        allowedTestOrigins,
      });
      const worker = new NotificationWorker({
        store,
        provider,
        workerId: process.env.WORKER_ID ?? `worker-${randomUUID()}`,
        leaseMs: parseIntegerEnvironment('LEASE_MS', 30_000, { min: 1 }),
        crashCooldownMs: parseIntegerEnvironment('CRASH_COOLDOWN_MS', 10_000, { min: 0 }),
        afterProviderResponse: async ({ result }) => {
          if (process.env.CRASH_AFTER_PROVIDER_ACCEPTED === '1' && result.status >= 200 && result.status < 300) {
            process.kill(process.pid, 'SIGKILL');
          }
        },
      });
      const result = await worker.runOne();
      process.stdout.write(`${JSON.stringify({ kind: 'worker_receipt', ...result })}\n`);
      return;
    }
    if (command !== 'serve') throw new ValidationError('command must be migrate, serve, stats, or work-once');

    const service = new NotificationService({
      store,
      templates: createDefaultTemplateRegistry(),
    });
    const server = createHttpServer({
      service,
      authTokens: authTokenMap(),
      health: () => store.ping(),
      logger: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
    });
    const host = process.env.HOST ?? '127.0.0.1';
    const port = parseIntegerEnvironment('PORT', 3000, { min: 0, max: 65_535 });
    server.listen(port, host);
    await once(server, 'listening');
    const address = server.address();
    process.stdout.write(`${JSON.stringify({ kind: 'api_listening', port: address.port })}\n`);

    const shutdown = async () => {
      server.close();
      await once(server, 'close');
      await pool.end();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    keepPoolOpen = true;
  } finally {
    if (!keepPoolOpen) await pool.end();
  }
}

run().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    kind: 'fatal',
    name: error?.name ?? 'Error',
    code: error?.code ?? 'internal_error',
  })}\n`);
  process.exitCode = 1;
});
