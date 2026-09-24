import path from "node:path";

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

export function loadConfig(env = process.env) {
  const environment = env.NODE_ENV || "development";
  const authRequired = asBool(env.WHATSAPP_AUTH_REQUIRED, true);
  if (environment === "production" && !authRequired) {
    throw new Error("WHATSAPP_AUTH_REQUIRED cannot be disabled in production");
  }
  return Object.freeze({
    environment,
    port: Number(env.PORT || 8782),
    productionSend: asBool(env.WHATSAPP_PRODUCTION_SEND),
    bulkSend: asBool(env.WHATSAPP_BULK_SEND),
    aiAutoreply: asBool(env.WHATSAPP_AI_AUTOREPLY),
    externalRecipients: asBool(env.WHATSAPP_EXTERNAL_RECIPIENTS),
    middlewareBaseUrl: env.MIDDLEWARE_BASE_URL || "http://middleware-integration-api:8095",
    middlewareCommandPath: env.MIDDLEWARE_COMMAND_PATH || "/platform/v1/commands",
    middlewareCommandType: env.MIDDLEWARE_COMMAND_TYPE || "",
    middlewareTarget: env.MIDDLEWARE_TARGET || "",
    middlewareCapability: env.MIDDLEWARE_CAPABILITY || "",
    dataDir: path.resolve(env.WHATSAPP_DATA_DIR || "./var/whatsapp"),
    internalApiToken: env.WHATSAPP_INTERNAL_API_TOKEN || "",
    authIssuer: env.WHATSAPP_AUTH_ISSUER || "",
    authAudience: env.WHATSAPP_AUTH_AUDIENCE || "codestra-whatsapp",
    authPublicKey: (env.WHATSAPP_AUTH_PUBLIC_KEY || "").replace(/\\n/g, "\n"),
    authRequired,
    maxInboundAttempts: Number(env.WHATSAPP_MAX_INBOUND_ATTEMPTS || 5),
    baseRetryMs: Number(env.WHATSAPP_BASE_RETRY_MS || 1000),
    maxPageSize: Number(env.WHATSAPP_MAX_PAGE_SIZE || 100)
  });
}
