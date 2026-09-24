import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const readJson = async (path) => JSON.parse(await fs.readFile(new URL(path, import.meta.url), "utf8"));

test("inbound event contract remains fail-closed and versioned", async () => {
  const schema = await readJson("../contracts/events/whatsapp.inbound.v1.schema.json");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schema_version.const, "whatsapp.inbound.v1");
  for (const required of ["event_id", "provider_event_id", "correlation_id", "tenant_id", "payload_hash", "content"]) {
    assert.ok(schema.required.includes(required));
  }
});

test("conversation transition contract requires tenant, audit and optimistic concurrency guards", async () => {
  const contract = await readJson("../contracts/conversations/conversation-state.v1.json");
  assert.equal(contract.schema_version, "whatsapp.conversation-state.v1");
  assert.equal(contract.guards.tenant_scoped, true);
  assert.equal(contract.guards.audit_event_required, true);
  assert.equal(contract.guards.optimistic_concurrency_required, true);
  assert.equal(contract.human_takeover.cancel_pending_automation, true);
  assert.equal(contract.out_of_order_events.allow_silent_overwrite, false);
});
