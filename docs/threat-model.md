# Threat model

## Assets and trust boundaries

- API and provider bearer credentials;
- tenant identity and idempotency binding;
- opaque recipient references, template variables, and rendered payloads;
- notification preferences and their versions;
- provider endpoints, status/reason responses, and message identifiers;
- PostgreSQL state, attempt history, backups, logs, and metrics.

Tenant callers are trusted only for their own token scope. Recipient data and template variables remain untrusted input. Provider
responses and network failures are untrusted external data. Operator environment configuration is privileged but fallible.

## Threats and current controls

| Threat | Current control | Remaining gap |
|---|---|---|
| Cross-tenant submission/read | bearer token maps to server-side tenant; body cannot choose tenant | static token map has no rotation/audit service |
| Idempotency-key reuse to change content | unique tenant/key plus immutable canonical digest | no tenant quota or key-retention policy |
| Oversized/malformed input | body, identifier, variable count/bytes, channel, time, template, and payload limits | no campaign/fanout admission control |
| Template injection | plain-text-only registered templates and exact variable schema | no HTML/email escaping because HTML is out of scope |
| Preference bypass | worker reads current persisted version before call; marketing default deny | concurrent post-decision disable cannot retract I/O |
| Credential/PII leakage | no raw identifiers/content/credentials in application logs; safe error envelope | database/backups still need encryption and access control |
| SSRF or credential forwarding | provider URLs are operator config, HTTPS-only; exact loopback exception in test; redirects disabled | no network-layer egress allowlist or DNS pinning |
| Retry amplification | bounded attempts, expiry, backoff, jitter, and `Retry-After` cap | no global circuit breaker or adaptive admission control |
| Stale worker overwrite | lease token fences every completion | no lease renewal for long provider calls |
| Duplicate external effect | stable delivery key plus explicit unknown receipt/counterexample | real providers may not deduplicate; exactly once is absent |
| Supply-chain compromise | lockfile, `npm ci --ignore-scripts`, audit, pinned Actions, minimal permissions | audit cannot prove dependency behavior or future safety |

## Abuse boundaries

This repository is not permission to send messages. Real operation requires verified recipient ownership, channel-specific consent,
unsubscribe/token lifecycle, tenant quotas, content policy, audit trails, incident response, and applicable legal/privacy review.
None is inferred from a provider accepting a request.
