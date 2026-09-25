import { requireString } from "./domain.mjs";

export async function submitMiddlewareCommand(config, input, authorization) {
  const commandType = requireString(config.middlewareCommandType, "MIDDLEWARE_COMMAND_TYPE");
  const tenantId = requireString(input.tenant_id, "tenant_id");
  const requestedBy = requireString(input.requested_by, "requested_by");
  const idempotencyKey = requireString(input.idempotency_key, "idempotency_key", 8);
  const correlationId = requireString(input.correlation_id, "correlation_id");
  const commandId = requireString(input.command_id, "command_id");
  requireString(authorization, "Authorization");

  const campaignId = requireString(input.campaign_id ?? input.business_context?.campaign_id, "campaign_id");
  const businessContext = { ...(input.business_context ?? {}), campaign_id: campaignId };
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
      campaign_id: campaignId,
      recipient: input.recipient,
      instance_id: input.instance_id ?? null,
      message: input.message,
      business_context: businessContext
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
      "x-command-id": commandId,
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


export async function readMiddlewareOperation(config, operationId, authorization, tenantId, correlationId) {
  requireString(operationId, "operation_id");
  requireString(authorization, "Authorization");
  requireString(tenantId, "tenant_id");
  const correlation = requireString(correlationId, "correlation_id");

  const path = `${config.middlewareOperationPathPrefix}${encodeURIComponent(operationId)}`;
  const url = new URL(path, config.middlewareBaseUrl).toString();
  const response = await fetch(url, {
    method: "GET",
    headers: {
      authorization,
      "x-tenant-id": tenantId,
      "x-correlation-id": correlation
    },
    signal: AbortSignal.timeout(10000)
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }
  return { ok: response.ok, status: response.status, middleware: body };
}
