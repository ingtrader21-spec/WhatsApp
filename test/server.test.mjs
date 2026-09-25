import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

async function withServer(env, fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codestra-whatsapp-server-"));
  const server = createApp(loadConfig({ PORT: "0", WHATSAPP_DATA_DIR: dataDir, WHATSAPP_AUTH_REQUIRED: "false", WHATSAPP_INTERNAL_API_TOKEN: "test-internal", ...env }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); await once(server, "close"); }
}

test("strict eligibility blocks non-opted-in contacts", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + "/platform/v1/whatsapp/contacts/eligibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: "15550000000", consent_status: "unknown", suppressed: false })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.eligible, false);
    assert.ok(body.reasons.includes("consent_not_opted_in"));
  });
});

test("production send is fail-closed by default", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + "/platform/v1/whatsapp/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 423);
    const body = await res.json();
    assert.equal(body.error.code, "whatsapp_production_send_disabled");
  });
});

test("readiness reports durable W3 store and Middleware registry dependency", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + "/readyz");
    const body = await res.json();
    assert.equal(body.middleware_command_type_configured, false);
    assert.equal(body.safe_mode, true);
    assert.equal(body.w3_durable_store_ready, true);
  });
});


test("message submission derives tenant and actor and emits top-level campaign scope", async () => {
  let captured;
  const submit = async (config, input, authorization) => {
    captured = { input, authorization };
    return { status: 202, middleware: { operation_id: "op-1", state: "QUEUED" } };
  };
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codestra-whatsapp-server-"));
  const config = loadConfig({
    PORT: "0",
    WHATSAPP_DATA_DIR: dataDir,
    WHATSAPP_AUTH_REQUIRED: "false",
    WHATSAPP_INTERNAL_API_TOKEN: "test-internal",
    WHATSAPP_PRODUCTION_SEND: "true",
    WHATSAPP_EXTERNAL_RECIPIENTS: "true",
    MIDDLEWARE_COMMAND_TYPE: "whatsapp.message.send.v1"
  });
  const server = createApp(config, { submitMiddlewareCommand: submit });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(base + "/platform/v1/whatsapp/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer passthrough",
        "x-tenant-id": "TENANT-1",
        "x-actor-id": "agent-1",
        "x-command-id": "11111111-1111-4111-8111-111111111111",
        "x-correlation-id": "corr-1",
        "idempotency-key": "idem-12345678"
      },
      body: JSON.stringify({
        recipient: "15550000000",
        campaign_id: "cmp-1",
        consent_status: "opted_in",
        suppressed: false,
        opted_out: false,
        message: { type: "text", text: "hello" }
      })
    });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("location"), "/platform/v1/whatsapp/operations/op-1");
    assert.equal(captured.input.tenant_id, "TENANT-1");
    assert.equal(captured.input.requested_by, "agent-1");
    assert.equal(captured.input.campaign_id, "cmp-1");
    assert.equal(captured.input.idempotency_key, "idem-12345678");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("message submission rejects header/body idempotency conflicts", async () => {
  await withServer({
    WHATSAPP_PRODUCTION_SEND: "true",
    WHATSAPP_EXTERNAL_RECIPIENTS: "true",
    MIDDLEWARE_COMMAND_TYPE: "whatsapp.message.send.v1"
  }, async (base) => {
    const res = await fetch(base + "/platform/v1/whatsapp/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer passthrough",
        "x-tenant-id": "TENANT-1",
        "x-actor-id": "agent-1",
        "idempotency-key": "idem-header-123"
      },
      body: JSON.stringify({
        idempotency_key: "idem-body-456",
        recipient: "15550000000",
        campaign_id: "cmp-1",
        consent_status: "opted_in",
        suppressed: false,
        opted_out: false,
        message: { type: "text", text: "hello" }
      })
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "header_body_mismatch");
  });
});

test("operation endpoint reads authoritative Middleware status", async () => {
  const readOperation = async (config, operationId, authorization, tenantId, correlationId) => {
    assert.equal(operationId, "op-123");
    assert.equal(tenantId, "TENANT-1");
    assert.equal(correlationId, "corr-read");
    return { status: 200, middleware: { operation_id: operationId, state: "COMPLETED" } };
  };
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codestra-whatsapp-server-"));
  const config = loadConfig({ PORT: "0", WHATSAPP_DATA_DIR: dataDir, WHATSAPP_AUTH_REQUIRED: "false", WHATSAPP_INTERNAL_API_TOKEN: "test-internal" });
  const server = createApp(config, { readMiddlewareOperation: readOperation });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(base + "/platform/v1/whatsapp/operations/op-123", {
      headers: {
        authorization: "Bearer passthrough",
        "x-tenant-id": "TENANT-1",
        "x-actor-id": "agent-1",
        "x-correlation-id": "corr-read"
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.middleware.state, "COMPLETED");
    assert.equal(res.headers.get("x-correlation-id"), "corr-read");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("json responses are no-store and nosniff", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + "/healthz");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});
