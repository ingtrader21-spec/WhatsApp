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
