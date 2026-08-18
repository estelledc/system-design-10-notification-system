import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, test } from 'node:test';
import {
  HttpProviderClient,
  ProviderNetworkError,
  ProviderProtocolError,
  ValidationError,
} from '../../src/index.js';

const servers = [];

async function fixture(handler) {
  const server = createServer(handler);
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

function delivery() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    channel: 'push',
    recipientRef: 'recipient-001',
    payload: { title: 'Alert', body: 'Changed' },
    expiresAtMs: 10_000,
  };
}

test('provider client sends a stable delivery key and reads an acceptance receipt', async () => {
  let observed;
  const origin = await fixture(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    observed = { headers: request.headers, body: JSON.parse(body) };
    response.writeHead(202, {
      'content-type': 'application/json',
      'x-provider-message-id': 'provider-message-001',
    });
    response.end('{}');
  });
  const client = new HttpProviderClient({
    endpoints: { push: `${origin}/send` },
    bearerToken: 'provider-test-token',
    nodeEnv: 'test',
    allowedTestOrigins: [origin],
    clock: () => 1_000,
  });
  const result = await client.send(delivery());
  assert.equal(result.status, 202);
  assert.equal(result.providerMessageId, 'provider-message-001');
  assert.equal(observed.headers['x-delivery-key'], delivery().id);
  assert.equal(observed.headers.authorization, 'Bearer provider-test-token');
  assert.equal(observed.body.recipientRef, 'recipient-001');
});

test('provider client refuses plain HTTP unless the exact origin is a test fixture', async () => {
  assert.throws(() => new HttpProviderClient({
    endpoints: { push: 'http://127.0.0.1:9999/send' },
    nodeEnv: 'production',
  }), ValidationError);
  assert.throws(() => new HttpProviderClient({
    endpoints: { push: 'http://127.0.0.1:9999/send' },
    nodeEnv: 'test',
    allowedTestOrigins: ['http://127.0.0.1:9998'],
  }), ValidationError);
});

test('provider client does not follow redirects and parses Retry-After', async () => {
  let redirectTargetRequests = 0;
  const target = await fixture((request, response) => {
    redirectTargetRequests += 1;
    response.writeHead(202, { 'x-provider-message-id': 'unexpected' });
    response.end('{}');
  });
  const origin = await fixture((request, response) => {
    response.writeHead(302, { location: `${target}/effect`, 'retry-after': '30' });
    response.end('{}');
  });
  const client = new HttpProviderClient({
    endpoints: { push: `${origin}/send` },
    nodeEnv: 'test',
    allowedTestOrigins: [origin],
    clock: () => 1_000,
  });
  const result = await client.send(delivery());
  assert.equal(result.status, 302);
  assert.equal(result.retryAfterMs, 30_000);
  assert.equal(redirectTargetRequests, 0);
});

test('provider client rejects malformed accepted responses and classifies timeouts as network uncertainty', async () => {
  const malformed = await fixture((request, response) => {
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const malformedClient = new HttpProviderClient({
    endpoints: { push: `${malformed}/send` },
    nodeEnv: 'test',
    allowedTestOrigins: [malformed],
  });
  await assert.rejects(
    malformedClient.send(delivery()),
    (error) => error instanceof ProviderProtocolError
      && error.externalOutcomeUnknown === true
      && error.providerStatus === 202,
  );

  const hanging = await fixture(() => {});
  const timeoutClient = new HttpProviderClient({
    endpoints: { push: `${hanging}/send` },
    nodeEnv: 'test',
    allowedTestOrigins: [hanging],
    timeoutMs: 20,
  });
  await assert.rejects(timeoutClient.send(delivery()), ProviderNetworkError);
});

test('provider client still classifies malformed failure bodies from the HTTP status', async () => {
  const origin = await fixture((request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '30' });
    response.end('temporarily unavailable');
  });
  const client = new HttpProviderClient({
    endpoints: { push: `${origin}/send` },
    nodeEnv: 'test',
    allowedTestOrigins: [origin],
    clock: () => 1_000,
  });
  const result = await client.send(delivery());
  assert.equal(result.status, 503);
  assert.equal(result.code, null);
  assert.equal(result.retryAfterMs, 30_000);
});

test('provider client can trust a bounded acceptance id header when the optional body is malformed', async () => {
  const origin = await fixture((request, response) => {
    response.writeHead(202, {
      'content-type': 'text/plain',
      'x-provider-message-id': 'provider-message-header',
    });
    response.end('not json');
  });
  const client = new HttpProviderClient({
    endpoints: { push: `${origin}/send` },
    nodeEnv: 'test',
    allowedTestOrigins: [origin],
  });
  const result = await client.send(delivery());
  assert.equal(result.status, 202);
  assert.equal(result.providerMessageId, 'provider-message-header');
});
