import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyJwtRs256, identityFromClaims } from "../src/auth.mjs";

function token(privateKey, payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

test("RS256 verification enforces issuer, audience and Keycloak role extraction", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = {
    authPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    authIssuer: "https://auth.codestra.test/realms/codestra",
    authAudience: "codestra-whatsapp",
    authAzp: "codestra-whatsapp-frontend"
  };
  const raw = token(privateKey, {
    sub: "agent-123",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    iss: config.authIssuer,
    aud: config.authAudience,
    azp: config.authAzp,
    exp: Math.floor(Date.now() / 1000) + 60,
    realm_access: { roles: ["whatsapp_agent"] }
  });
  const claims = verifyJwtRs256(raw, config);
  const identity = identityFromClaims(claims);
  assert.equal(identity.subject, "agent-123");
  assert.equal(identity.tenantId, "11111111-1111-4111-8111-111111111111");
  assert.equal(identity.roles.has("whatsapp_agent"), true);
});

test("tampered RS256 token fails closed", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = { authPublicKey: publicKey.export({ type: "spki", format: "pem" }), authIssuer: "issuer", authAudience: "aud" };
  const raw = token(privateKey, { sub: "a", tenant_id: "t", iss: "issuer", aud: "aud", exp: Math.floor(Date.now() / 1000) + 60 });
  const [h, p, s] = raw.split(".");
  const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: "admin", tenant_id: "other", iss: "issuer", aud: "aud", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url")}.${s}`;
  assert.throws(() => verifyJwtRs256(tampered, config), (error) => error.code === "invalid_token" && error.status === 401);
});


test("valid token from another Keycloak client is rejected", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = {
    authPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    authIssuer: "https://auth.codestra.co/realms/codestra",
    authAudience: "codestra-whatsapp",
    authAzp: "codestra-whatsapp-frontend"
  };
  const raw = token(privateKey, {
    sub: "agent-123",
    tenant_id: "tenant-1",
    iss: config.authIssuer,
    aud: config.authAudience,
    azp: "another-browser-client",
    exp: Math.floor(Date.now() / 1000) + 60,
    realm_access: { roles: ["whatsapp_agent"] }
  });
  assert.throws(
    () => verifyJwtRs256(raw, config),
    (error) => error.code === "invalid_token" && error.status === 401
  );
});
