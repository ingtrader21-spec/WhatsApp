# Codestra WhatsApp

Codestra WhatsApp is the business/application control plane for governed WhatsApp contacts, campaigns, conversations, automation and operator workflows.

## Authority boundary

All provider effects go through **Middleware V3 :8095** using the canonical `POST /platform/v1/commands` boundary.

This repository owns:

- contact/channel eligibility, consent and suppression integration;
- campaign validation and business-level message jobs;
- durable inbound event processing;
- conversation lifecycle, routing, assignment and human handoff;
- automation decisions and takeover controls;
- operator readback, audit evidence, DLQ/replay and observability.

It does **not** call Meta/Evolution directly and does not own provider sessions or Middleware's command ledger/outbox/reconciliation authority.

## W3 enterprise conversation runtime

W3 is implemented around an append-only fsync-backed application ledger with deterministic replay. The runtime provides:

- normalized `whatsapp.inbound.v1` ingestion;
- provider-event dedupe and conflicting-duplicate rejection;
- durable processing status and restart recovery;
- deterministic tenant-scoped conversation identity;
- optimistic conversation versions for operator mutations;
- out-of-order timestamp safety;
- immediate opt-out/suppression requests;
- automation pause/cancel on human takeover;
- assignment/escalation/resolve/reopen operations;
- append-only audit events;
- bounded retries, DLQ and authorized replay;
- Prometheus-style metrics;
- RS256 JWT verification for operator APIs;
- internal-token protection for ingress and metrics.

### Canonical W3 routes

- `POST /internal/v1/inbound-events`
- `GET /internal/v1/inbound-events/:eventId`
- `GET /internal/metrics`
- `GET /platform/v1/whatsapp/conversations`
- `GET /platform/v1/whatsapp/conversations/:id`
- `GET /platform/v1/whatsapp/conversations/:id/timeline`
- `POST /platform/v1/whatsapp/conversations/:id/claim`
- `POST /platform/v1/whatsapp/conversations/:id/assign`
- `POST /platform/v1/whatsapp/conversations/:id/escalate`
- `POST /platform/v1/whatsapp/conversations/:id/resolve`
- `POST /platform/v1/whatsapp/conversations/:id/reopen`
- `POST /platform/v1/whatsapp/conversations/:id/automation/pause`
- `POST /platform/v1/whatsapp/conversations/:id/automation/resume`
- `GET /platform/v1/whatsapp/dead-letters`
- `POST /platform/v1/whatsapp/dead-letters/:id/replay`

Mutation requests require the current `expected_version`; stale state fails with `409` rather than silently overwriting a newer operator action.

## Safety defaults

These remain off until staging/production certification:

- `WHATSAPP_PRODUCTION_SEND=false`
- `WHATSAPP_BULK_SEND=false`
- `WHATSAPP_AI_AUTOREPLY=false`
- `WHATSAPP_EXTERNAL_RECIPIENTS=false`

Production configuration refuses `WHATSAPP_AUTH_REQUIRED=false`.

## Development

```bash
npm run check
npm test
node src/server.mjs
```

No package install is required for the current runtime; it uses Node.js built-ins only.

## Promotion path

`feature/* -> development -> testing -> staging -> deployment -> main`

Every promotion requires exact-head tests, readback evidence and rollback readiness. Production external effects remain fail-closed until W5 explicitly certifies them.
