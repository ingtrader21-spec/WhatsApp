# Codestra WhatsApp

Codestra WhatsApp application layer for governed number verification, consent/suppression, customer messaging automation, product/service conversations, human escalation, and Middleware V3 integration.

## Environments

Promotion path: development -> testing -> staging -> deployment -> main.

Production effects remain fail-closed until CI, security, staging readback, observability, rollback, and explicit release approval are complete.

## Repository boundary

This repository is an independent Codestra delivery unit. Cross-repository integration uses versioned APIs, events, and webhooks. Preserve legally required third-party copyright, license, NOTICE, and attribution.
