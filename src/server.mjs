import http from "node:http";
import crypto from "node:crypto";
import { loadConfig } from "./config.mjs";
import { DomainError, evaluateEligibility, requireString, validateCampaign } from "./domain.mjs";
import { readMiddlewareOperation, submitMiddlewareCommand } from "./middleware.mjs";
import { authorizeInternal, authorizeOperator } from "./auth.mjs";
import { ConversationService } from "./w3/service.mjs";

const MAX_BODY = 1024 * 1024;
const READ_ROLES = ["whatsapp_agent", "whatsapp_supervisor", "whatsapp_admin"];
const SUPERVISOR_ROLES = ["whatsapp_supervisor", "whatsapp_admin"];
const ADMIN_ROLES = ["whatsapp_admin"];

function requireJsonContentType(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new DomainError("unsupported_media_type", "content-type must be application/json", 415);
  }
}

async function readJson(req) {
  requireJsonContentType(req);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new DomainError("payload_too_large", "request body exceeds 1 MiB", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new DomainError("invalid_json", "request body must be valid JSON", 400);
  }
}

function json(res, status, body, headers = {}) {
  const correlation = typeof body?.correlation_id === "string" ? { "x-correlation-id": body.correlation_id } : {};
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...correlation,
    ...headers
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function routeMatch(pathname, expression) {
  const match = pathname.match(expression);
  return match ? match.groups || match.slice(1) : null;
}

export function createApp(config = loadConfig(), options = {}) {
  const w3 = options.w3Service || new ConversationService(config, options.w3Options);
  const submitCommand = options.submitMiddlewareCommand || submitMiddlewareCommand;
  const readOperation = options.readMiddlewareOperation || readMiddlewareOperation;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, {
          status: "ok",
          service: "codestra-whatsapp-app",
          command_authority: "middleware-v3",
          middleware_base_url: config.middlewareBaseUrl
        });
      }

      if (req.method === "GET" && url.pathname === "/readyz") {
        await w3.ready();
        return json(res, 200, {
          status: "ready",
          safe_mode: !config.productionSend,
          middleware_command_type_configured: Boolean(config.middlewareCommandType),
          w3_durable_store_ready: true,
          registry_dependency: config.middlewareCommandType ? null : "Middleware V3 WhatsApp command family must be registered before sends"
        });
      }

      if (req.method === "GET" && url.pathname === "/internal/metrics") {
        authorizeInternal(req, config);
        await w3.ready();
        return text(res, 200, w3.metricsText(), "text/plain; version=0.0.4; charset=utf-8");
      }

      if (req.method === "POST" && url.pathname === "/internal/v1/inbound-events") {
        authorizeInternal(req, config);
        const body = await readJson(req);
        const result = await w3.ingest(body);
        const status = result.duplicate ? 200 : result.dead_letter ? 202 : 202;
        return json(res, status, result, { location: `/internal/v1/inbound-events/${result.event.event_id}` });
      }

      const internalEvent = routeMatch(url.pathname, /^\/internal\/v1\/inbound-events\/(?<eventId>[^/]+)$/);
      if (req.method === "GET" && internalEvent) {
        authorizeInternal(req, config);
        await w3.ready();
        const event = w3.store.getEvent(internalEvent.eventId);
        if (!event) throw new DomainError("event_not_found", "event not found", 404);
        return json(res, 200, event);
      }

      if (req.method === "POST" && url.pathname === "/platform/v1/whatsapp/contacts/eligibility") {
        const body = await readJson(req);
        return json(res, 200, evaluateEligibility(body));
      }

      if (req.method === "POST" && url.pathname === "/platform/v1/whatsapp/campaigns/validate") {
        const body = await readJson(req);
        const result = validateCampaign(body);
        return json(res, result.valid ? 200 : 422, result);
      }

      if (req.method === "POST" && url.pathname === "/platform/v1/whatsapp/messages") {
        const identity = authorizeOperator(req, config, READ_ROLES);
        const body = await readJson(req);
        if (!config.productionSend) {
          return json(res, 423, {
            error: { code: "whatsapp_production_send_disabled", message: "External WhatsApp effects are disabled by default", retryable: false }
          });
        }
        if (!config.externalRecipients) {
          return json(res, 423, {
            error: { code: "external_recipients_disabled", message: "External recipients are disabled", retryable: false }
          });
        }
        if (!config.middlewareCommandType) {
          return json(res, 503, {
            error: { code: "middleware_whatsapp_command_unregistered", message: "Set MIDDLEWARE_COMMAND_TYPE only after the V3 registry entry is reviewed and deployed", retryable: false }
          });
        }

        const eligibility = evaluateEligibility({
          recipient: body.recipient,
          consent_status: body.consent_status,
          suppressed: body.suppressed,
          opted_out: body.opted_out
        });
        if (!eligibility.eligible) {
          return json(res, 403, { error: { code: "recipient_not_eligible", reasons: eligibility.reasons, retryable: false } });
        }

        const headerTenant = String(req.headers["x-tenant-id"] || identity.tenantId || "");
        if (headerTenant && identity.tenantId && headerTenant !== identity.tenantId) {
          throw new DomainError("tenant_mismatch", "x-tenant-id must match authenticated tenant", 403);
        }

        body.tenant_id = identity.tenantId;
        body.requested_by = identity.subject;
        body.idempotency_key ||= req.headers["idempotency-key"];
        body.command_id ||= req.headers["x-command-id"] || crypto.randomUUID();
        body.correlation_id ||= req.headers["x-correlation-id"] || crypto.randomUUID();

        requireString(body.tenant_id, "tenant_id");
        requireString(body.requested_by, "requested_by");
        requireString(body.idempotency_key, "idempotency_key", 8);
        requireString(body.recipient, "recipient");
        requireString(body.campaign_id ?? body.business_context?.campaign_id, "campaign_id");
        if (req.headers["idempotency-key"] && req.headers["idempotency-key"] !== body.idempotency_key) {
          throw new DomainError("header_body_mismatch", "Idempotency-Key must match request body", 409);
        }
        if (req.headers["x-correlation-id"] && req.headers["x-correlation-id"] !== body.correlation_id) {
          throw new DomainError("header_body_mismatch", "X-Correlation-ID must match request body", 409);
        }
        if (req.headers["x-command-id"] && req.headers["x-command-id"] !== body.command_id) {
          throw new DomainError("header_body_mismatch", "X-Command-ID must match request body", 409);
        }
        if (!body.message || typeof body.message !== "object") throw new DomainError("invalid_request", "message is required", 400);

        const authorization = req.headers.authorization;
        const result = await submitCommand(config, body, authorization);
        const location = result.middleware?.operation_id
          ? `/platform/v1/whatsapp/operations/${result.middleware.operation_id}`
          : "";
        return json(res, result.status, {
          command_authority: "middleware-v3",
          command_id: body.command_id,
          correlation_id: body.correlation_id,
          middleware: result.middleware
        }, location ? { location } : {});
      }

      const operation = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/operations\/(?<operationId>[^/]+)$/);
      if (req.method === "GET" && operation) {
        const identity = authorizeOperator(req, config, READ_ROLES);
        const correlationId = String(req.headers["x-correlation-id"] || crypto.randomUUID());
        const authorization = req.headers.authorization;
        const result = await readOperation(config, operation.operationId, authorization, identity.tenantId, correlationId);
        return json(res, result.status, {
          command_authority: "middleware-v3",
          correlation_id: correlationId,
          middleware: result.middleware
        });
      }

      if (req.method === "GET" && url.pathname === "/platform/v1/whatsapp/conversations") {
        const identity = authorizeOperator(req, config, READ_ROLES);
        await w3.ready();
        return json(res, 200, w3.listConversations(identity, Object.fromEntries(url.searchParams)));
      }

      const conversation = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/conversations\/(?<conversationId>[^/]+)$/);
      if (req.method === "GET" && conversation) {
        const identity = authorizeOperator(req, config, READ_ROLES);
        await w3.ready();
        return json(res, 200, w3.getConversation(identity, conversation.conversationId));
      }

      const timeline = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/conversations\/(?<conversationId>[^/]+)\/timeline$/);
      if (req.method === "GET" && timeline) {
        const identity = authorizeOperator(req, config, READ_ROLES);
        await w3.ready();
        return json(res, 200, { items: w3.timeline(identity, timeline.conversationId) });
      }

      const claim = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/conversations\/(?<conversationId>[^/]+)\/claim$/);
      if (req.method === "POST" && claim) {
        const identity = authorizeOperator(req, config, READ_ROLES);
        const body = await readJson(req);
        return json(res, 200, await w3.claim(identity, claim.conversationId, body.expected_version));
      }

      const assign = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/conversations\/(?<conversationId>[^/]+)\/assign$/);
      if (req.method === "POST" && assign) {
        const identity = authorizeOperator(req, config, SUPERVISOR_ROLES);
        const body = await readJson(req);
        return json(res, 200, await w3.assign(identity, assign.conversationId, body));
      }

      const escalate = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/conversations\/(?<conversationId>[^/]+)\/escalate$/);
      if (req.method === "POST" && escalate) {
        const identity = authorizeOperator(req, config, READ_ROLES);
        const body = await readJson(req);
        return json(res, 200, await w3.escalate(identity, escalate.conversationId, body.reason, body.expected_version));
      }

      const resolve = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/conversations\/(?<conversationId>[^/]+)\/resolve$/);
      if (req.method === "POST" && resolve) {
        const identity = authorizeOperator(req, config, READ_ROLES);
        const body = await readJson(req);
        return json(res, 200, await w3.resolve(identity, resolve.conversationId, body.reason, body.expected_version));
      }

      const reopen = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/conversations\/(?<conversationId>[^/]+)\/reopen$/);
      if (req.method === "POST" && reopen) {
        const identity = authorizeOperator(req, config, READ_ROLES);
        const body = await readJson(req);
        return json(res, 200, await w3.reopen(identity, reopen.conversationId, body.reason, body.expected_version));
      }

      const automation = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/conversations\/(?<conversationId>[^/]+)\/automation\/(?<action>pause|resume)$/);
      if (req.method === "POST" && automation) {
        const identity = authorizeOperator(req, config, READ_ROLES);
        const body = await readJson(req);
        return json(res, 200, await w3.setAutomationPaused(identity, automation.conversationId, automation.action === "pause", body.reason, body.expected_version));
      }

      if (req.method === "GET" && url.pathname === "/platform/v1/whatsapp/dead-letters") {
        const identity = authorizeOperator(req, config, ADMIN_ROLES);
        await w3.ready();
        return json(res, 200, { items: w3.listDeadLetters(identity) });
      }

      const replay = routeMatch(url.pathname, /^\/platform\/v1\/whatsapp\/dead-letters\/(?<deadLetterId>[^/]+)\/replay$/);
      if (req.method === "POST" && replay) {
        const identity = authorizeOperator(req, config, ADMIN_ROLES);
        return json(res, 200, await w3.replayDeadLetter(identity, replay.deadLetterId));
      }

      return json(res, 404, { error: { code: "not_found" } });
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 500;
      return json(res, status, {
        error: {
          code: error.code || "internal_error",
          message: status >= 500 && !(error instanceof DomainError) ? "internal server error" : error.message,
          retryable: status >= 500,
          ...(error instanceof DomainError && error.details ? { details: error.details } : {})
        }
      });
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const config = loadConfig();
  createApp(config).listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ service: "codestra-whatsapp-app", port: config.port, production_send: config.productionSend }));
  });
}
