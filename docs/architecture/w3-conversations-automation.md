# W3 — Enterprise Conversations & Automation Architecture

Status: **implemented W3 authority; staging certification still required**
GitHub mission: https://github.com/ingtrader21-spec/WhatsApp/issues/4
Branch: `feature/w3-conversations-automation`
Base: `development`

## Purpose and boundaries

W3 is the application authority for inbound events, conversations, routing/assignment, automation state, human handoff, audit, DLQ/replay and operator readback.

- W1 remains authoritative for contact/channel identity, consent, suppression and eligibility.
- W2 remains authoritative for outbound campaign execution and business-level message jobs.
- Middleware V3 remains authoritative for command idempotency, ledger/outbox/workers, provider effects and reconciliation.
- Evolution-API remains the provider connection/session transport gateway.

No W3 code calls provider APIs directly.

## Runtime flow

```text
Provider -> Evolution -> Middleware V3 -> normalized whatsapp.inbound.v1 event
  -> durable W3 ledger -> dedupe -> conversation state -> policy/routing
  -> automation state or human queue -> auditable command boundary -> Middleware V3
```

No assignment/automation processing occurs before durable event persistence.

## Durable event authority

The versioned event contract is `contracts/events/whatsapp.inbound.v1.schema.json`.

Each accepted event carries immutable event/provider/correlation/tenant identities, timestamps and a payload hash. `(tenant_id, provider_event_id)` is the duplicate authority:

- same provider ID + same payload hash => idempotent duplicate readback;
- same provider ID + different payload hash => `409 conflicting_duplicate` with audit evidence.

The ledger is append-only JSONL and each append is fsynced before in-memory materialization. W3 also computes its own canonical content fingerprint so duplicate safety does not trust the upstream hash alone. On restart the runtime reconstructs state and resumes accepted/retrying work. This implementation is a single-runtime durable application store; W5 must certify the persistent volume/topology used by staging and production before external activation.

## Conversation state machine

The versioned transition contract is `contracts/conversations/conversation-state.v1.json`.

```text
new -> active -> waiting_customer -> waiting_agent -> escalated -> resolved -> reopened
```

Transitions are tenant-scoped, audited and versioned. Operator mutations require `expected_version`; stale versions fail with `409` instead of overwriting newer state. New inbound traffic to a resolved conversation reopens it explicitly.

Out-of-order inbound events may be materialized in the timeline but may not regress `last_inbound_at`.

## Human takeover and automation safety

Automation decisions are durable records. Human claim/assignment, escalation, opt-out and manual automation pause cancel pending automation for that conversation. Customer-visible effect execution remains behind the existing Middleware V3 command boundary and production kill switches.

Opt-out phrases create a durable suppression request and immediately pause W3 automation. W1 remains the final suppression/eligibility authority.

## Security

Operator APIs use RS256 JWT verification with issuer/audience checks and Keycloak-style role extraction. Required roles are:

- `whatsapp_agent`
- `whatsapp_supervisor`
- `whatsapp_admin`

JWTs must contain `sub` and a tenant claim (`tenant_id`, `tenant` or `organization_id`). Tenant mismatch returns not-found semantics to avoid cross-tenant disclosure.

Internal ingestion and metrics require `x-internal-token`. Production refuses configuration with operator authentication disabled.

## Canonical API authority

### Internal

- `POST /internal/v1/inbound-events`
- `GET /internal/v1/inbound-events/{event_id}`
- `GET /internal/metrics`

Internal routes are not public-edge routes.

### Operator

- `GET /platform/v1/whatsapp/conversations`
- `GET /platform/v1/whatsapp/conversations/{conversation_id}`
- `GET /platform/v1/whatsapp/conversations/{conversation_id}/timeline`
- `POST /platform/v1/whatsapp/conversations/{conversation_id}/claim`
- `POST /platform/v1/whatsapp/conversations/{conversation_id}/assign`
- `POST /platform/v1/whatsapp/conversations/{conversation_id}/escalate`
- `POST /platform/v1/whatsapp/conversations/{conversation_id}/resolve`
- `POST /platform/v1/whatsapp/conversations/{conversation_id}/reopen`
- `POST /platform/v1/whatsapp/conversations/{conversation_id}/automation/{pause|resume}`
- `GET /platform/v1/whatsapp/dead-letters`
- `POST /platform/v1/whatsapp/dead-letters/{dead_letter_id}/replay`

Collections are server-filtered and cursor-paginated.

## Failure recovery

W3 provides:

- durable persistence before processing;
- duplicate-safe materialization keyed to inbound event identity;
- bounded exponential retry schedule with in-process wake-up timers and restart recovery;
- dead-letter records after terminal/exhausted failures;
- privileged replay with audit lineage;
- poison/malformed event rejection before acceptance;
- restart reconstruction and pending-work recovery;
- no silent overwrite on stale operator state.

The certification invariant is **zero silent accepted-event loss**: an accepted event is processed, retrying, dead-lettered, or explicitly represented in durable state.

## Observability

`GET /internal/metrics` exposes W3 counters/gauges including inbound events, duplicates, conflicting duplicates, processed events, retries, dead letters, replays, handoffs, escalations, active conversation count and pending automation count.

Audit records carry tenant, actor, action, conversation/event correlation and reason metadata. Application error responses suppress unexpected internal exception messages.

## Initial service objectives

Staging must prove:

- zero duplicate customer-visible effects in retry/replay tests;
- zero accepted-event loss through restart tests;
- deterministic stale-version rejection;
- tenant isolation;
- immediate opt-out automation pause;
- successful DLQ recovery without duplicate message materialization;
- exact-head CI pass on supported Node versions.

## Promotion gate

W3 can merge to `development` when exact-head CI and independent review are green. Environment promotion remains:

```text
feature/w3-conversations-automation -> development -> testing -> staging -> deployment -> main
```

No current W3 change enables production messaging. W5 still owns staging persistence/topology, Middleware registry integration, rollback rehearsal and explicit production approval.
