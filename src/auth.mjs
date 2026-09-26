import crypto from "node:crypto";
import { DomainError } from "./domain.mjs";

function decodeJson(segment, label) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new DomainError("invalid_token", `invalid JWT ${label}`, 401);
  }
}

function audienceMatches(value, expected) {
  return Array.isArray(value) ? value.includes(expected) : value === expected;
}

export function verifyJwtRs256(token, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new DomainError("invalid_token", "bearer token must be a JWT", 401);
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJson(headerPart, "header");
  const payload = decodeJson(payloadPart, "payload");
  if (header.alg !== "RS256") throw new DomainError("invalid_token", "only RS256 is accepted", 401);
  if (!config.authPublicKey) throw new DomainError("auth_not_configured", "authorization verifier is not configured", 503);
  const signature = Buffer.from(signaturePart, "base64url");
  const valid = crypto.verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), config.authPublicKey, signature);
  if (!valid) throw new DomainError("invalid_token", "JWT signature verification failed", 401);
  if (payload.exp !== undefined && Number(payload.exp) <= nowSeconds) throw new DomainError("token_expired", "JWT expired", 401);
  if (payload.nbf !== undefined && Number(payload.nbf) > nowSeconds) throw new DomainError("token_not_active", "JWT not active yet", 401);
  if (config.authIssuer && payload.iss !== config.authIssuer) throw new DomainError("invalid_token", "JWT issuer mismatch", 401);
  if (config.authAudience && !audienceMatches(payload.aud, config.authAudience)) throw new DomainError("invalid_token", "JWT audience mismatch", 401);
  if (config.authAzp && payload.azp !== config.authAzp) throw new DomainError("invalid_token", "JWT authorized party mismatch", 401);
  return payload;
}

export function identityFromClaims(payload = {}) {
  const realmRoles = payload.realm_access?.roles || [];
  const resourceRoles = Object.values(payload.resource_access || {}).flatMap((v) => v?.roles || []);
  const roles = new Set([...realmRoles, ...resourceRoles, ...(Array.isArray(payload.roles) ? payload.roles : [])]);
  const tenantId = payload.tenant_id || payload.tenant || payload.organization_id || null;
  return {
    subject: payload.sub || null,
    tenantId,
    roles,
    claims: payload
  };
}

export function authorizeOperator(req, config, allowedRoles) {
  if (!config.authRequired) {
    const tenantId = req.headers["x-tenant-id"];
    if (!tenantId) throw new DomainError("tenant_required", "x-tenant-id is required when auth is disabled", 401);
    return { subject: req.headers["x-actor-id"] || "development-actor", tenantId, roles: new Set(["whatsapp_admin"]), claims: {} };
  }
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) throw new DomainError("unauthorized", "Bearer authorization is required", 401);
  const identity = identityFromClaims(verifyJwtRs256(auth.slice(7), config));
  if (!identity.subject || !identity.tenantId) throw new DomainError("invalid_token", "JWT subject and tenant are required", 401);
  if (allowedRoles?.length && !allowedRoles.some((role) => identity.roles.has(role))) {
    throw new DomainError("forbidden", "required role is missing", 403);
  }
  return identity;
}

export function authorizeInternal(req, config) {
  if (!config.internalApiToken) throw new DomainError("internal_auth_not_configured", "internal API token is not configured", 503);
  const supplied = String(req.headers["x-internal-token"] || "");
  const expected = String(config.internalApiToken);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new DomainError("unauthorized", "invalid internal API token", 401);
  }
}
