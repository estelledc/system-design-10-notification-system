import { createServer } from 'node:http';
import { AppError, AuthenticationError, ValidationError } from './errors.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(encoded);
}

async function readJson(request, maximumBytes) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new ValidationError('content-type must be application/json');
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new ValidationError('request body is too large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new ValidationError('request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('request body is not valid JSON');
  }
}

function authenticate(request, authTokens) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new AuthenticationError();
  const tenantId = authTokens.get(authorization.slice('Bearer '.length));
  if (!tenantId) throw new AuthenticationError();
  return tenantId;
}

export function createHttpServer({ service, authTokens, health = async () => true, logger = () => {}, maximumBodyBytes = 65_536 }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        await health();
        json(response, 200, { ok: true });
        return;
      }
      const tenantId = authenticate(request, authTokens);
      if (request.method === 'POST' && url.pathname === '/v1/notifications') {
        const idempotencyKey = request.headers['idempotency-key'];
        const result = await service.submit({
          tenantId,
          idempotencyKey,
          request: await readJson(request, maximumBodyBytes),
        });
        logger({ kind: 'notification_intake', created: result.created, channelCount: result.deliveries.length });
        json(response, result.created ? 201 : 200, result);
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/preferences') {
        const result = await service.setPreference({
          tenantId,
          preference: await readJson(request, maximumBodyBytes),
        });
        logger({ kind: 'preference_updated', enabled: result.enabled, version: result.version });
        json(response, 200, result);
        return;
      }
      const match = url.pathname.match(/^\/v1\/notifications\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        if (!uuidPattern.test(match[1])) throw new ValidationError('notification ID is invalid');
        json(response, 200, await service.getIntent({ tenantId, intentId: match[1] }));
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      const safe = error instanceof AppError ? error : new AppError('Internal error');
      logger({ kind: 'request_failed', code: safe.code, status: safe.status });
      json(response, safe.status, { error: safe.code });
    }
  });
}
