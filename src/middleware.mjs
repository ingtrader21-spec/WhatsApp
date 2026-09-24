import { requireString } from "./domain.mjs";

export async function submitMiddlewareCommand(config, input, authorization) {
  const commandType = requireString(config.middlewareCommandType, "MIDDLEWARE_COMMAND_TYPE");
  const tenantId = requireString(input.tenant_id, "tenant_id");
  const requestedBy = requireString(input.requested_by, "requested_by");
  const idempotencyKey = requireString(input.idempotency_key, "idempotency_key", 8);
  const correlationId = requireString(input.correlation_id, "correlation_id");
  const commandId = requireString(input.command_id, "command_id");
  requireString(authorization, "Authorization");

  const envelope = {
    command_id: commandId,
    command_type: commandType,
    command_version: "1.0",
    tenant_id: tenantId,
    requested_by: requestedBy,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    payload: {
      channel: "whatsapp",
      recipient: input.recipient,
      instance_id: input.instance_id ?? null,
      message: input.message,
      business_context: input.business_context ?? {}
    }
  };
  if (config.middlewareTarget) envelope.target = config.middlewareTarget;
  if (config.middlewareCapability) envelope.capability = config.middlewareCapability;

  const url = new URL(config.middlewareCommandPath, config.middlewareBaseUrl).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-tenant-id": tenantId,
      "x-correlation-id": correlationId,
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(10000)
  });

  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }

  return {
    ok: response.ok,
    status: response.status,
    envelope,
    middleware: body
  };
}
