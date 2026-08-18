# API and provider contracts

## Authentication

API callers use `Authorization: Bearer <token>`. `AUTH_TOKENS_JSON` maps each configured token to one tenant. Tenant identity is
never accepted from the request body. Tokens are operator configuration and are never logged or returned.

## Submit an intent

`POST /v1/notifications`

Headers:

- `Authorization: Bearer ...`
- `Idempotency-Key: request-key-00000001` (16–128 safe identifier characters)
- `Content-Type: application/json`

Example body:

```json
{
  "recipientRef": "recipient-001",
  "notificationClass": "transactional",
  "templateId": "account-alert",
  "templateVersion": 1,
  "variables": {
    "title": "Billing alert",
    "body": "A payment needs attention"
  },
  "channels": ["push", "email"],
  "scheduledAtMs": 1800000000000,
  "expiresAtMs": 1800003600000,
  "priority": 5
}
```

The request is normalized before hashing: channel order and variable object key order do not change identity, while array order,
content, template version, schedule, expiry, priority, recipient, or notification class do. A new intent returns `201`; an exact
replay returns `200`; a changed digest under the same tenant/key returns `409 idempotency_conflict`.

The response exposes intent/delivery IDs and states, not rendered payloads, recipient data, the idempotency key, or provider IDs.

## Update a preference

`PUT /v1/preferences`

```json
{
  "recipientRef": "recipient-001",
  "channel": "push",
  "notificationClass": "marketing",
  "enabled": true
}
```

Each write increments a persisted preference version. A worker records the version used for its final decision. A change that
commits before that decision is observed; a concurrent change after the decision cannot retract an external provider request.
Suppressed work is terminal and is not automatically resurrected by a later enable.

## Read state

`GET /v1/notifications/{uuid}` returns the authenticated tenant's intent and channel states. A tenant cannot read another
tenant's intent. `GET /healthz` is unauthenticated and checks PostgreSQL connectivity; it reveals only `{ "ok": true }`.

## Provider adapter

`PROVIDER_URLS_JSON` maps `push`, `email`, or `sms` to operator-controlled HTTPS endpoints. The worker sends:

- `POST` with JSON body `{ deliveryId, recipientRef, payload, expiresAtMs }`;
- stable `X-Delivery-Key: <delivery UUID>` on every attempt;
- optional provider bearer credential from `PROVIDER_BEARER_TOKEN`;
- no redirects and a bounded timeout/response body.

A successful adapter response must be `2xx` and contain a bounded message identifier in `X-Provider-Message-Id` or JSON. The
repository treats that as provider acceptance only. A stable delivery key is not assumed to be a provider deduplication feature;
the runtime smoke demonstrates both a provider that honors it and one that does not.

Generic classification in this reference adapter:

| Response | State |
|---|---|
| `2xx` plus message ID | `provider_accepted` |
| `2xx` without a usable message ID | terminal `provider_outcome_unknown`; no automatic retry |
| `404`, `410`, or known unregistered code | terminal `invalid_recipient` |
| `408`, `425`, `429`, `500`, `502`, `503`, `504`, timeout/network uncertainty | bounded retry |
| other response or pre-call adapter protocol violation | terminal failure |

Real provider adapters must replace this generic table with that provider's current status/reason contract. In particular, a
generic HTTP status alone can be ambiguous.

## Error envelope

API errors contain only a stable code:

```json
{ "error": "invalid_request" }
```

Expected codes include `unauthorized`, `invalid_request`, `idempotency_conflict`, `not_found`, and
`dependency_unavailable`. Request fields and credentials are not echoed.
