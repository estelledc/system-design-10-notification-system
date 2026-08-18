import { CHANNELS } from './contracts.js';
import { ProviderNetworkError, ProviderProtocolError, ValidationError } from './errors.js';
import { parseRetryAfter } from './policy.js';

function validateEndpoint(value, { nodeEnv, allowedTestOrigins }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('provider endpoint must be an absolute URL');
  }
  if (url.username || url.password || url.hash) throw new ValidationError('provider endpoint contains forbidden URL fields');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && nodeEnv === 'test' && allowedTestOrigins.has(url.origin)) return url;
  throw new ValidationError('provider endpoints require HTTPS outside an exact test origin');
}

async function cancelBody(response) {
  await response.body?.cancel().catch(() => {});
}

async function boundedJson(response, maximumBytes) {
  const declaredHeader = response.headers.get('content-length');
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await cancelBody(response);
    return { body: {}, issue: 'Provider response exceeded the declared body limit' };
  }
  if (!response.body) return { body: {}, issue: null };

  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel().catch(() => {});
        return { body: {}, issue: 'Provider response exceeded the body limit' };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { body: {}, issue: 'Provider response body could not be read' };
  } finally {
    reader.releaseLock();
  }

  if (received === 0) return { body: {}, issue: null };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks, received).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body: {}, issue: 'Provider response JSON was not an object' };
    }
    return { body: parsed, issue: null };
  } catch {
    return { body: {}, issue: 'Provider response was not valid JSON' };
  }
}

export class HttpProviderClient {
  constructor({
    endpoints,
    bearerToken,
    timeoutMs = 5_000,
    maximumResponseBytes = 16_384,
    clock = Date.now,
    nodeEnv = process.env.NODE_ENV,
    allowedTestOrigins = [],
  }) {
    if (!endpoints || typeof endpoints !== 'object') throw new ValidationError('provider endpoints are required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new ValidationError('provider timeout must be a positive integer');
    }
    if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
      throw new ValidationError('provider response limit must be a positive integer');
    }
    const origins = new Set(allowedTestOrigins);
    this.endpoints = new Map();
    for (const [channel, value] of Object.entries(endpoints)) {
      if (!CHANNELS.includes(channel)) throw new ValidationError(`unsupported provider channel: ${channel}`);
      this.endpoints.set(channel, validateEndpoint(value, { nodeEnv, allowedTestOrigins: origins }));
    }
    this.bearerToken = bearerToken;
    this.timeoutMs = timeoutMs;
    this.maximumResponseBytes = maximumResponseBytes;
    this.clock = clock;
  }

  async send(delivery) {
    const endpoint = this.endpoints.get(delivery.channel);
    if (!endpoint) throw new ProviderProtocolError('No provider endpoint is configured for the delivery channel');
    const headers = {
      'content-type': 'application/json',
      'x-delivery-key': delivery.id,
    };
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          deliveryId: delivery.id,
          recipientRef: delivery.recipientRef,
          payload: delivery.payload,
          expiresAtMs: delivery.expiresAtMs,
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProviderNetworkError(error);
    }
    const { body, issue } = await boundedJson(response, this.maximumResponseBytes);
    const providerMessageId = response.headers.get('x-provider-message-id') ?? body.providerMessageId ?? null;
    const code = typeof body.code === 'string' ? body.code.slice(0, 128) : null;
    if (response.status >= 200 && response.status < 300 && (
      typeof providerMessageId !== 'string' || providerMessageId.length < 1 || providerMessageId.length > 256
    )) {
      throw new ProviderProtocolError(issue ?? 'Accepted provider response omitted a bounded message identifier', {
        externalOutcomeUnknown: true,
        providerStatus: response.status,
        providerCode: code,
      });
    }
    return {
      status: response.status,
      code,
      providerMessageId,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), this.clock()),
    };
  }
}
