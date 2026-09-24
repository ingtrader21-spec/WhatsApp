# W3 — Enterprise Conversations & Automation Architecture

Status: **active design authority for W3**
GitHub mission: https://github.com/ingtrader21-spec/WhatsApp/issues/4
Branch: `feature/w3-conversations-automation`
Base: `development`

## 1. Purpose

W3 defines the production-grade application authority for inbound WhatsApp conversations, routing, automation, agent takeover, escalation, readback, replay, audit and operational recovery.

The design is intentionally transport-independent. Provider sessions and provider-specific transport remain in Evolution-API. All external messaging effects are issued through Middleware V3.

## 2. Authority boundaries

| Domain | Authority |
|---|---|
| Contact/channel identity, consent, suppression, eligibility | W1 |
| Campaign scheduling, audience execution, per-recipient outbound jobs | W2 |
| Conversations, inbound events, routing, automation, human handoff | **W3** |
| Operator web experience | W4 |
| Cross-system integration, staging and production certification | W5 |
| Command ledger/outbox/worker/reconciliation/provider effect | Middleware V3 |
| Provider connection/session transport | Evolution-API |

W3 must consume W1/W2 contracts and must not create parallel contact, consent, campaign or provider-session authority.

## 3. End-to-end architecture

```text
WhatsApp Provider
      |
      v
Evolution transport gateway
      |
      v
Middleware V3 :8095
      |
      v
Normalized inbound event
      |
      v
Durable W3 event ledger
      |
      +--> Idempotency / duplicate detector
      |
      v
Conversation state machine
      |
      v
Routing + policy engine
      |
      +--> Automation decision ----> auditable response command ----> Middleware V3
      |
      +--> Human queue / assignment / escalation
      |
      v
Operator readback APIs + metrics + traces + audit
```

### Processing rule

No automation or assignment side effect may occur until the inbound event is durably recorded and assigned an immutable event identity.

## 4. Versioned inbound event envelope

Initial logical contract:

```json
{
  "schema_version": "whatsapp.inbound.v1",
  "event_id": "uuid",
  "provider_event_id": "string",
  "correlation_id": "uuid",
  "tenant_id": "uuid",
  "channel": "whatsapp",
  "sender_identity": "normalized-channel-identity",
  "recipient_identity": "normalized-channel-identity",
  "event_type": "message.received",
  "provider_timestamp": "RFC3339",
  "ingested_at": "RFC3339",
  "payload_hash": "sha256",
  "content": {
    "type": "text",
    "text": "..."
  },
  "metadata": {}
}
```

Rules:

- `event_id` is immutable.
- `provider_event_id + tenant_id` participates in duplicate detection.
- `payload_hash` detects conflicting duplicates.
- Raw provider payload may be retained only according to data-retention policy.
- Logs must not emit secrets or unnecessary message content.

## 5. Core entities

### InboundEvent
Immutable ingestion record with processing state, attempt count, next-attempt time, duplicate relation, DLQ state and replay lineage.

### Conversation
Tenant-scoped deterministic conversation identity and current lifecycle state.

### ConversationMessage
Immutable customer-visible or operator-visible message record linked to an inbound event or outbound command.

### ConversationAssignment
Current owner/team plus versioned assignment history.

### AutomationDecision
Input facts, policy result, confidence, selected action, reason code and model/config version where AI is involved.

### AutomationAction
Pending/executed/cancelled application action. Must be idempotent.

### AgentHandoff
Explicit transition from automation to human control, including reason and context watermark.

### Escalation
Supervisor/team escalation state with SLA metadata.

### AuditEvent
Append-only security and operational evidence.

### DeadLetterEvent
Failed event processing record with reason, attempts, remediation state and replay lineage.

## 6. Conversation lifecycle

Allowed lifecycle:

```text
new
  -> active
  -> waiting_customer
  -> waiting_agent
  -> escalated
  -> resolved
  -> reopened
```

Transitions must be:

- explicit and validated;
- versioned or optimistic-lock protected;
- tenant-scoped;
- audit recorded;
- safe against duplicate/out-of-order events.

Resolution and reopen operations require a reason code.

## 7. Assignment and routing

Routing inputs may include:

- tenant/business unit;
- skill/team;
- service/product domain;
- business hours;
- customer priority;
- language;
- current queue depth;
- agent availability.

Supported strategy contracts:

- deterministic fallback queue;
- round-robin;
- least-loaded;
- explicit supervisor assignment.

Every automatic assignment records the evaluated rules and selected reason.

## 8. Automation policy engine

Automation executes only after policy evaluation.

Required controls:

- per-tenant enablement;
- per-conversation pause;
- explicit confidence threshold;
- deterministic fallback;
- tool/action allowlist;
- W1 eligibility/suppression readback;
- no fabricated price, availability, guarantee, certification or completion claims;
- no marketing automation after opt-out or suppression;
- no customer-visible duplicate after retry or replay.

Human takeover immediately invalidates or cancels pending automation for the conversation version being taken over.

## 9. Human handoff contract

A handoff must preserve:

- full permitted conversation history;
- customer identity reference;
- service/product context;
- current automation state;
- reason for handoff;
- SLA state;
- prior assignments;
- pending actions.

Operator notes are never customer-visible unless deliberately converted into a response.

## 10. API surfaces

Proposed versioned application API authority:

### Operator/readback
- `GET /v1/conversations`
- `GET /v1/conversations/{conversation_id}`
- `GET /v1/conversations/{conversation_id}/timeline`
- `POST /v1/conversations/{conversation_id}/claim`
- `POST /v1/conversations/{conversation_id}/assign`
- `POST /v1/conversations/{conversation_id}/escalate`
- `POST /v1/conversations/{conversation_id}/resolve`
- `POST /v1/conversations/{conversation_id}/reopen`
- `POST /v1/conversations/{conversation_id}/automation/pause`
- `POST /v1/conversations/{conversation_id}/automation/resume`

### Internal ingestion/operations
- `POST /internal/v1/inbound-events`
- `GET /internal/v1/inbound-events/{event_id}`
- `GET /internal/v1/dead-letters`
- `POST /internal/v1/dead-letters/{dead_letter_id}/replay`

Internal routes are never exposed directly through the public edge.

All collection APIs require cursor pagination and server-side filtering.

## 11. Reliability model

### Delivery semantics
W3 targets **at-least-once event delivery with effectively-once customer-visible effects** through idempotency and command dedupe.

### Mandatory recovery controls
- persistence before processing;
- bounded retry with exponential backoff and jitter;
- idempotency keys;
- duplicate detection;
- DLQ;
- authorized replay;
- poison-message quarantine;
- deterministic worker restart recovery;
- queue/backlog limits;
- circuit-breaking around downstream dependencies.

### Non-negotiable invariant
**Zero silent message loss.** Every accepted inbound event must be either processed, retrying, dead-lettered, quarantined or explicitly rejected with evidence.

## 12. Security and privacy

- tenant isolation on every entity and query;
- Keycloak-backed RBAC;
- agent, supervisor, administrator and system scopes;
- replay restricted to privileged roles;
- append-only audit events;
- no secrets in payloads/logs;
- PII-minimized structured logs;
- retention/deletion policy hooks;
- rate limits and abuse controls;
- internal APIs protected from public ingress.

## 13. Observability

### Metrics
- inbound events/sec;
- duplicate rate;
- processing latency;
- queue depth;
- retry count/rate;
- DLQ size/growth;
- automation decision rate;
- human-handoff rate;
- unresolved conversations;
- assignment latency;
- SLA breach count/rate;
- outbound command failure rate.

### Logs
Structured fields must include, where applicable:

- tenant_id;
- correlation_id;
- event_id;
- conversation_id;
- command_id;
- assignment_id;
- automation_decision_id;
- outcome/reason_code.

### Tracing
Trace continuity must cover:

```text
Evolution -> Middleware V3 -> W3 ingestion -> state transition -> automation/assignment -> Middleware V3 outbound command
```

### Health
Expose health/readiness signals separately. Readiness must fail when W3 cannot safely persist or process new inbound work.

## 14. Initial service objectives

These are engineering targets subject to staging capacity validation:

- committed inbound event durability: no acknowledged event without durable record;
- duplicate customer-visible effect rate: 0 in certification tests;
- replay duplicate-effect rate: 0 in certification tests;
- conversation readback freshness: near-real-time after committed transition;
- recovery: deterministic after worker restart without manual data repair;
- observability: all failed processing paths produce metric + structured-log evidence.

## 15. Test and certification matrix

Required automated coverage:

- duplicate provider event;
- conflicting duplicate payload;
- out-of-order event;
- worker crash after persistence;
- worker crash before state transition;
- downstream timeout;
- retry after timeout;
- duplicate retry;
- low-confidence automation;
- forbidden action/tool;
- opt-out detected mid-conversation;
- suppression already active;
- human takeover during pending automation;
- assignment race;
- agent unavailable;
- tenant isolation violation;
- unauthorized replay;
- DLQ replay;
- replay after original success;
- stale version/concurrency conflict;
- outage and recovery;
- malformed/poison event.

## 16. Promotion gate

W3 may merge into `development` only when:

1. event/domain schemas are versioned and reviewed;
2. durable/idempotent ingestion is implemented;
3. conversation state transitions are tested;
4. human takeover is duplicate-safe;
5. opt-out/suppression policy integration is tested;
6. tenant/RBAC/audit tests pass;
7. DLQ/replay tests pass;
8. metrics/logs/traces are present;
9. exact-head tests pass;
10. PR includes runtime/readback evidence and known risks.

Environment promotion remains:

```text
feature/w3-conversations-automation
  -> development
  -> testing
  -> staging
  -> deployment
  -> main
```

No production messaging capability is enabled by this architecture document.
