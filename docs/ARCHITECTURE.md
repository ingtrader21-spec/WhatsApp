# Architecture

## Command authority

Middleware V3 :8095 is the single command/idempotency/ledger/outbox/retry/DLQ/replay/reconciliation authority.

The canonical submit route is:

`POST /platform/v1/commands`

The application forwards the caller's Authorization token and sends the exact V3 command envelope:

- command_id
- command_type
- command_version = 1.0
- tenant_id
- requested_by
- correlation_id
- idempotency_key
- payload

Headers mirror tenant/correlation/idempotency so the V3 kernel can verify body/header consistency.

## Registry blocker

As of the implementation baseline, the Middleware V3 repository has no WhatsApp command family in its command registry. Therefore MIDDLEWARE_COMMAND_TYPE is intentionally empty by default and sends fail closed.

Planned command family: `whatsapp.message.send.v1` (subject to reviewed Middleware registry contract).

## Provider boundary

WhatsApp app -> Middleware V3 -> Evolution provider adapter -> provider.

No application route calls Meta or Evolution directly.
