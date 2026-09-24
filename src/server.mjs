import http from "node:http";
import crypto from "node:crypto";
import { loadConfig } from "./config.mjs";
import { DomainError, evaluateEligibility, requireString, validateCampaign } from "./domain.mjs";
import { submitMiddlewareCommand } from "./middleware.mjs";

const MAX_BODY = 1024 * 1024;

async function readJson(req) {
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

export function createApp(config = loadConfig()) {
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
        return json(res, 200, {
          status: "ready",
          safe_mode: !config.productionSend,
          middleware_command_type_configured: Boolean(config.middlewareCommandType),
          registry_dependency: config.middlewareCommandType ? null : "Middleware V3 WhatsApp command family must be registered before sends"
        });
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

        requireString(body.tenant_id, "tenant_id");
        requireString(body.requested_by, "requested_by");
        requireString(body.idempotency_key, "idempotency_key", 8);
        requireString(body.recipient, "recipient");

        body.command_id ||= crypto.randomUUID();
        body.correlation_id ||= crypto.randomUUID();
        if (!body.message || typeof body.message !== "object") throw new DomainError("invalid_request", "message is required", 400);

        const authorization = req.headers.authorization;
        const result = await submitMiddlewareCommand(config, body, authorization);
        return json(res, result.status, {
          command_authority: "middleware-v3",
          command_id: body.command_id,
          correlation_id: body.correlation_id,
          middleware: result.middleware
        }, { location: result.middleware?.operation_id ? `/platform/v1/operations/${result.middleware.operation_id}` : "" });
      }

      return json(res, 404, { error: { code: "not_found" } });
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 500;
      return json(res, status, {
        error: {
          code: error.code || "internal_error",
          message: error.message,
          retryable: false
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
