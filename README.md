# Codestra WhatsApp

Business/application layer for WhatsApp.

## V3 boundary

All provider effects go through **Middleware V3 :8095** using the canonical `POST /platform/v1/commands` contract.

This repository owns:

- contact/channel eligibility
- consent and suppression rules
- campaign validation and business-level message jobs
- conversation/inbox and automation surfaces
- operator UX/reporting

It does not call Meta/Evolution directly and does not own the transport command ledger, durable outbox, retry scheduler, DLQ/replay or reconciliation.

## Current implementation slice

- health/readiness
- strict recipient eligibility guard
- campaign validation
- fail-closed message submission proxy to Middleware V3
- exact V3 command-envelope mapping
- production kill switch defaults off

The Middleware V3 WhatsApp command family is not registered yet. Keep `MIDDLEWARE_COMMAND_TYPE` empty until the reviewed registry entry exists.

## Run

```powershell
node src/server.mjs
node --test
```
