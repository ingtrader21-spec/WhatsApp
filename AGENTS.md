# Agent Contract

1. All external WhatsApp provider effects go through Middleware V3 :8095.
2. Never call Evolution, Baileys or Meta directly from application code.
3. Transport command idempotency, ledger/outbox, retry, DLQ/replay and reconciliation belong to Middleware V3.
4. Keep WHATSAPP_PRODUCTION_SEND=false by default.
5. Enforce suppression/opt-out before command submission.
6. Never commit tokens or provider secrets.
7. Use isolated branches/worktrees and leave exact SHA/tests/handoff.
