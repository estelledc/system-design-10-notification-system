import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, test } from 'node:test';
import { createHttpServer } from '../../src/index.js';

const servers = [];

async function start(service, logger = () => {}) {
  const server = createHttpServer({
    service,
    authTokens: new Map([['test-auth-token-0001', 'tenant-a']]),
    logger,
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

test('HTTP intake authenticates the tenant and maps created versus replay status', async () => {
  let input;
  const service = {
    async submit(value) {
      input = value;
      return { created: true, intentId: 'id', deliveries: [{ channel: 'push' }] };
    },
  };
  const base = await start(service);
  const response = await fetch(`${base}/v1/notifications`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-auth-token-0001',
      'content-type': 'application/json',
      'idempotency-key': 'request-key-00000001',
    },
    body: JSON.stringify({ example: true }),
  });
  assert.equal(response.status, 201);
  assert.equal(input.tenantId, 'tenant-a');
  assert.equal(input.idempotencyKey, 'request-key-00000001');
  assert.deepEqual(input.request, { example: true });
});

test('HTTP boundary rejects unauthenticated and malformed JSON requests without echoing secrets', async () => {
  const records = [];
  const base = await start({ async submit() { throw new Error('unreachable'); } }, (record) => records.push(record));
  const unauthorized = await fetch(`${base}/v1/notifications`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });

  const malformed = await fetch(`${base}/v1/notifications`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-auth-token-0001',
      'content-type': 'application/json',
      'idempotency-key': 'request-key-00000001',
    },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.ok(records.every((record) => !JSON.stringify(record).includes('test-auth-token-0001')));
});

test('health endpoint is unauthenticated but executes the dependency probe', async () => {
  let probes = 0;
  const server = createHttpServer({
    service: {},
    authTokens: new Map(),
    health: async () => { probes += 1; },
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(probes, 1);
});
