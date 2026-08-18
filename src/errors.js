export class AppError extends Error {
  constructor(message, { code = 'internal_error', status = 500, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed') {
    super(message, { code: 'invalid_request', status: 400 });
  }
}

export class AuthenticationError extends AppError {
  constructor() {
    super('Authentication required', { code: 'unauthorized', status: 401 });
  }
}

export class RequestConflictError extends AppError {
  constructor() {
    super('Idempotency key is already bound to a different request', {
      code: 'idempotency_conflict',
      status: 409,
    });
  }
}

export class NotFoundError extends AppError {
  constructor() {
    super('Notification was not found', { code: 'not_found', status: 404 });
  }
}

export class LeaseLostError extends AppError {
  constructor() {
    super('Delivery lease is no longer current', { code: 'lease_lost', status: 409 });
  }
}

export class DependencyError extends AppError {
  constructor(message = 'Dependency operation failed', cause) {
    super(message, { code: 'dependency_unavailable', status: 503, cause });
  }
}

export class ProviderNetworkError extends AppError {
  constructor(cause) {
    super('Provider request failed before a classified response', {
      code: 'provider_network_error',
      status: 503,
      cause,
    });
  }
}

export class ProviderProtocolError extends AppError {
  constructor(message = 'Provider response violated the configured adapter contract', {
    externalOutcomeUnknown = false,
    providerStatus = null,
    providerCode = null,
  } = {}) {
    super(message, { code: 'provider_protocol_error', status: 502 });
    this.externalOutcomeUnknown = externalOutcomeUnknown;
    this.providerStatus = providerStatus;
    this.providerCode = providerCode;
  }
}
