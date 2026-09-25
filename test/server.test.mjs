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
      headers: {
        "content-type": "application/json",
        "x-tenant-id": "TEST_SYN",
        "x-actor-id": "agent-1"
      },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 423);
    const body = await res.json();
    assert.equal(body.error.code, "whatsapp_production_send_disabled");
  });
});



test("message submission authenticates before exposing production gates", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + "/platform/v1/whatsapp/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "tenant_required");
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


test("agent console business APIs persist contacts templates campaigns and dashboard counts", async () => {
  await withServer({}, async (base) => {
    const headers = {
      "content-type": "application/json",
      "x-tenant-id": "TENANT-1",
      "x-actor-id": "supervisor-1"
    };

    const contactRes = await fetch(base + "/platform/v1/whatsapp/contacts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Jane Customer",
        phone: "+18095550101",
        consent_status: "opted_in",
        tags: ["vip", "transport"]
      })
    });
    assert.equal(contactRes.status, 201);
    const contact = await contactRes.json();
    assert.equal(contact.version, 1);
    assert.equal(contact.consent_status, "opted_in");

    const templateRes = await fetch(base + "/platform/v1/whatsapp/templates", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Appointment reminder",
        language: "en",
        category: "utility",
        status: "approved",
        body: "Hello {{1}}, your appointment is confirmed.",
        variables: ["name"]
      })
    });
    assert.equal(templateRes.status, 201);
    const template = await templateRes.json();

    const campaignRes = await fetch(base + "/platform/v1/whatsapp/campaigns", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "September reminders",
        template_id: template.template_id,
        audience_count: 1,
        bulk_approved: false,
        status: "ready"
      })
    });
    assert.equal(campaignRes.status, 201);
    const campaign = await campaignRes.json();
    assert.equal(campaign.status, "ready");
    assert.equal(campaign.validation.valid, true);

    const contacts = await (await fetch(base + "/platform/v1/whatsapp/contacts?q=Jane", {
      headers: { "x-tenant-id": "TENANT-1", "x-actor-id": "agent-1" }
    })).json();
    assert.equal(contacts.total, 1);
    assert.equal(contacts.items[0].contact_id, contact.contact_id);

    const dashboardRes = await fetch(base + "/platform/v1/whatsapp/dashboard", {
      headers: { "x-tenant-id": "TENANT-1", "x-actor-id": "agent-1" }
    });
    assert.equal(dashboardRes.status, 200);
    const dashboard = await dashboardRes.json();
    assert.equal(dashboard.business.contacts.total, 1);
    assert.equal(dashboard.business.contacts.opted_in, 1);
    assert.equal(dashboard.business.templates.approved, 1);
    assert.equal(dashboard.business.campaigns.ready, 1);

    const me = await (await fetch(base + "/platform/v1/whatsapp/me", {
      headers: { "x-tenant-id": "TENANT-1", "x-actor-id": "agent-1" }
    })).json();
    assert.equal(me.subject, "agent-1");
    assert.equal(me.tenant_id, "TENANT-1");
    assert.ok(me.roles.includes("whatsapp_admin"));
  });
});

test("business object updates reject stale versions", async () => {
  await withServer({}, async (base) => {
    const headers = {
      "content-type": "application/json",
      "x-tenant-id": "TENANT-1",
      "x-actor-id": "supervisor-1"
    };
    const created = await (await fetch(base + "/platform/v1/whatsapp/contacts", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Versioned Contact", phone: "+18095550102", consent_status: "unknown" })
    })).json();

    const stale = await fetch(base + "/platform/v1/whatsapp/contacts/" + created.contact_id, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Stale Update", expected_version: 99 })
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "stale_version");
  });
});

test("message send derives recipient and eligibility from stored contact", async () => {
  let captured;
  const submit = async (config, input, authorization) => {
    captured = { input, authorization };
    return { status: 202, middleware: { operation_id: "op-contact-1", state: "QUEUED" } };
  };
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codestra-whatsapp-console-"));
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
    const base = "http://127.0.0.1:" + server.address().port;
    const authHeaders = {
      "content-type": "application/json",
      authorization: "Bearer passthrough",
      "x-tenant-id": "TENANT-1",
      "x-actor-id": "agent-1"
    };
    const contact = await (await fetch(base + "/platform/v1/whatsapp/contacts", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "Eligible Contact", phone: "+18095550103", consent_status: "opted_in" })
    })).json();

    const send = await fetch(base + "/platform/v1/whatsapp/messages", {
      method: "POST",
      headers: {
        ...authHeaders,
        "x-command-id": "11111111-1111-4111-8111-111111111112",
        "x-correlation-id": "corr-contact-1",
        "idempotency-key": "idem-contact-0001"
      },
      body: JSON.stringify({
        contact_id: contact.contact_id,
        campaign_id: "cmp-single-1",
        message: { type: "text", text: "Hello from the agent console" }
      })
    });
    assert.equal(send.status, 202);
    assert.equal(captured.input.recipient, "+18095550103");
    assert.equal(captured.input.consent_status, "opted_in");
    assert.equal(captured.input.suppressed, false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("suppressed stored contact blocks provider command submission", async () => {
  let calls = 0;
  const submit = async () => {
    calls += 1;
    return { status: 202, middleware: {} };
  };
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codestra-whatsapp-console-"));
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
    const base = "http://127.0.0.1:" + server.address().port;
    const authHeaders = {
      "content-type": "application/json",
      authorization: "Bearer passthrough",
      "x-tenant-id": "TENANT-1",
      "x-actor-id": "agent-1"
    };
    const contact = await (await fetch(base + "/platform/v1/whatsapp/contacts", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "Suppressed Contact",
        phone: "+18095550104",
        consent_status: "opted_in",
        suppressed: true
      })
    })).json();

    const send = await fetch(base + "/platform/v1/whatsapp/messages", {
      method: "POST",
      headers: { ...authHeaders, "idempotency-key": "idem-contact-0002" },
      body: JSON.stringify({
        contact_id: contact.contact_id,
        campaign_id: "cmp-single-2",
        message: { type: "text", text: "This must not send" }
      })
    });
    assert.equal(send.status, 403);
    assert.equal((await send.json()).error.code, "recipient_not_eligible");
    assert.equal(calls, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});


test("frontend CORS is explicit allowlist and fails closed for other origins", async () => {
  await withServer({ WHATSAPP_FRONTEND_ORIGIN: "https://whatsapp.codestra.co" }, async (base) => {
    const allowed = await fetch(base + "/platform/v1/whatsapp/dashboard", {
      method: "OPTIONS",
      headers: { origin: "https://whatsapp.codestra.co" }
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://whatsapp.codestra.co");
    assert.ok(allowed.headers.get("access-control-allow-headers").includes("X-Command-ID"));

    const denied = await fetch(base + "/platform/v1/whatsapp/dashboard", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" }
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  });
});
