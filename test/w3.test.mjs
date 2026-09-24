import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { loadConfig } from "../src/config.mjs";
import { ConversationService } from "../src/w3/service.mjs";
import { createApp } from "../src/server.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codestra-whatsapp-w3-"));
}

function makeConfig(dataDir, overrides = {}) {
  return loadConfig({
    PORT: "0",
    WHATSAPP_DATA_DIR: dataDir,
    WHATSAPP_INTERNAL_API_TOKEN: "internal-test-token",
    WHATSAPP_AUTH_REQUIRED: "false",
    WHATSAPP_AI_AUTOREPLY: "true",
    WHATSAPP_MAX_INBOUND_ATTEMPTS: "3",
    WHATSAPP_BASE_RETRY_MS: "1",
    ...overrides
  });
}

function inbound(overrides = {}) {
  const content = overrides.content || { type: "text", text: "I need help with a service" };
  const raw = JSON.stringify(content);
  return {
    schema_version: "whatsapp.inbound.v1",
    event_id: crypto.randomUUID(),
    provider_event_id: `provider-${crypto.randomUUID()}`,
    correlation_id: crypto.randomUUID(),
    tenant_id: "11111111-1111-4111-8111-111111111111",
    channel: "whatsapp",
    sender_identity: "+15550000001",
    recipient_identity: "+15559999999",
    event_type: "message.received",
    provider_timestamp: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    payload_hash: crypto.createHash("sha256").update(raw).digest("hex"),
    content,
    metadata: {},
    ...overrides
  };
}

const admin = (tenantId = "11111111-1111-4111-8111-111111111111") => ({
  subject: "agent-1",
  tenantId,
  roles: new Set(["whatsapp_admin"]),
  claims: {}
});

test("duplicate provider events are idempotent and materialize one message", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  const event = inbound();
  const first = await svc.ingest(event);
  const second = await svc.ingest({ ...event });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.conversation.conversation_id, second.conversation.conversation_id);
  assert.equal(svc.store.getMessages(first.conversation.conversation_id).length, 1);
});

test("same provider event id with different payload is rejected", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  const event = inbound();
  await svc.ingest(event);
  const changed = { ...event, payload_hash: "a".repeat(64), content: { type: "text", text: "different" } };
  await assert.rejects(() => svc.ingest(changed), (error) => error.code === "conflicting_duplicate" && error.status === 409);
});

test("opt-out creates suppression request and pauses automation immediately", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  const event = inbound({ content: { type: "text", text: "STOP" } });
  event.payload_hash = crypto.createHash("sha256").update(JSON.stringify(event.content)).digest("hex");
  const result = await svc.ingest(event);
  const conversation = svc.store.getConversation(result.conversation.conversation_id);
  assert.equal(conversation.automation_paused, true);
  assert.ok(svc.store.getSuppressionRequest(event.tenant_id, event.sender_identity));
  assert.equal(svc.store.listAutomationsForConversation(conversation.conversation_id).length, 0);
});

test("human request transitions to waiting_agent and human claim cancels pending automation", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  const first = await svc.ingest(inbound({ content: { type: "text", text: "What services do you offer?" } }));
  let automations = svc.store.listAutomationsForConversation(first.conversation.conversation_id);
  assert.equal(automations.length, 1);
  assert.equal(automations[0].status, "pending");

  const event2 = inbound({
    sender_identity: first.conversation.customer_identity,
    recipient_identity: first.conversation.business_identity,
    content: { type: "text", text: "I want a human agent" }
  });
  event2.payload_hash = crypto.createHash("sha256").update(JSON.stringify(event2.content)).digest("hex");
  const second = await svc.ingest(event2);
  assert.equal(second.conversation.status, "waiting_agent");

  const beforeClaim = svc.getConversation(admin(), second.conversation.conversation_id);
  const claimed = await svc.claim(admin(), second.conversation.conversation_id, beforeClaim.version);
  assert.equal(claimed.assigned_to, "agent-1");
  assert.equal(claimed.automation_paused, true);
  automations = svc.store.listAutomationsForConversation(claimed.conversation_id);
  assert.equal(automations[0].status, "cancelled");
});

test("tenant isolation hides conversations from another tenant", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  const result = await svc.ingest(inbound());
  assert.throws(() => svc.getConversation(admin("22222222-2222-4222-8222-222222222222"), result.conversation.conversation_id), (error) => error.status === 404);
});

test("durable ledger reconstructs conversations after service restart", async () => {
  const dir = await tempDir();
  const config = makeConfig(dir);
  const svc1 = new ConversationService(config);
  const result = await svc1.ingest(inbound());
  const id = result.conversation.conversation_id;
  const svc2 = new ConversationService(config);
  await svc2.ready();
  const restored = svc2.getConversation(admin(), id);
  assert.equal(restored.conversation_id, id);
  assert.equal(svc2.store.getMessages(id).length, 1);
});

test("dead-letter replay recovers without duplicating customer-visible message", async () => {
  const dir = await tempDir();
  let fail = true;
  const config = makeConfig(dir, { WHATSAPP_MAX_INBOUND_ATTEMPTS: "1" });
  const svc = new ConversationService(config, {
    failureInjector: async () => {
      if (fail) throw new Error("simulated processing outage");
    }
  });
  const result = await svc.ingest(inbound());
  assert.equal(result.event.processing_status, "dead_letter");
  const deadLetters = svc.listDeadLetters(admin());
  assert.equal(deadLetters.length, 1);
  fail = false;
  const replayed = await svc.replayDeadLetter(admin(), deadLetters[0].dead_letter_id);
  assert.equal(replayed.event.processing_status, "processed");
  assert.equal(svc.listDeadLetters(admin()).length, 0);
  assert.equal(svc.store.getMessages(replayed.conversation.conversation_id).length, 1);
});

test("operator pagination and server-side status filtering are deterministic", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  await svc.ingest(inbound({ sender_identity: "+15550000011" }));
  await svc.ingest(inbound({ sender_identity: "+15550000012" }));
  const first = svc.listConversations(admin(), { limit: "1" });
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor);
  const second = svc.listConversations(admin(), { limit: "1", cursor: first.next_cursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].conversation_id, second.items[0].conversation_id);
  const active = svc.listConversations(admin(), { status: "active" });
  assert.equal(active.items.length, 2);
});

test("HTTP ingress, readback, timeline and metrics operate through guarded routes", async () => {
  const dir = await tempDir();
  const config = makeConfig(dir);
  const server = createApp(config);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const event = inbound();
    const ingest = await fetch(`${base}/internal/v1/inbound-events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": "internal-test-token" },
      body: JSON.stringify(event)
    });
    assert.equal(ingest.status, 202);
    const accepted = await ingest.json();
    const conversationId = accepted.conversation.conversation_id;

    const list = await fetch(`${base}/platform/v1/whatsapp/conversations`, { headers: { "x-tenant-id": event.tenant_id } });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).items.length, 1);

    const timeline = await fetch(`${base}/platform/v1/whatsapp/conversations/${conversationId}/timeline`, { headers: { "x-tenant-id": event.tenant_id } });
    assert.equal(timeline.status, 200);
    assert.ok((await timeline.json()).items.length >= 2);

    const metrics = await fetch(`${base}/internal/metrics`, { headers: { "x-internal-token": "internal-test-token" } });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /codestra_whatsapp_w3_inbound_events_total/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("internal ingestion fails closed without configured token", async () => {
  const dir = await tempDir();
  const config = makeConfig(dir, { WHATSAPP_INTERNAL_API_TOKEN: "" });
  const server = createApp(config);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/internal/v1/inbound-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inbound())
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "internal_auth_not_configured");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("out-of-order inbound events never regress last_inbound_at", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  const newer = inbound({ provider_timestamp: "2026-09-24T05:00:00.000Z" });
  const first = await svc.ingest(newer);
  const older = inbound({
    sender_identity: newer.sender_identity,
    recipient_identity: newer.recipient_identity,
    provider_timestamp: "2026-09-24T04:00:00.000Z",
    content: { type: "text", text: "older delivery" }
  });
  older.payload_hash = crypto.createHash("sha256").update(JSON.stringify(older.content)).digest("hex");
  await svc.ingest(older);
  const conversation = svc.getConversation(admin(), first.conversation.conversation_id);
  assert.equal(conversation.last_inbound_at, "2026-09-24T05:00:00.000Z");
  assert.equal(svc.store.getMessages(conversation.conversation_id).length, 2);
});

test("optimistic concurrency rejects stale operator mutations", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  const result = await svc.ingest(inbound());
  const current = svc.getConversation(admin(), result.conversation.conversation_id);
  const paused = await svc.setAutomationPaused(admin(), current.conversation_id, true, "agent_review", current.version);
  assert.equal(paused.automation_paused, true);
  await assert.rejects(
    () => svc.resolve(admin(), current.conversation_id, "resolved", current.version),
    (error) => error.code === "stale_conversation_version" && error.status === 409
  );
});

test("production configuration cannot disable operator authentication", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", WHATSAPP_AUTH_REQUIRED: "false" }),
    /cannot be disabled in production/
  );
});


test("concurrent duplicate ingress is serialized before acceptance", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  const event = inbound();
  const [a, b] = await Promise.all([svc.ingest(event), svc.ingest(structuredClone(event))]);
  assert.equal([a.duplicate, b.duplicate].filter(Boolean).length, 1);
  const conversation = a.conversation || b.conversation;
  assert.equal(svc.store.getMessages(conversation.conversation_id).length, 1);
  assert.equal(svc.store.events.size, 1);
});

test("same provider event id with changed content conflicts even if supplied payload hash is reused", async () => {
  const dir = await tempDir();
  const svc = new ConversationService(makeConfig(dir));
  const event = inbound();
  await svc.ingest(event);
  const changed = { ...event, content: { type: "text", text: "changed but reused provider hash" } };
  await assert.rejects(() => svc.ingest(changed), (error) => error.code === "conflicting_duplicate" && error.status === 409);
});

test("retry timer processes due work without requiring a service restart", async () => {
  const dir = await tempDir();
  let failures = 1;
  const svc = new ConversationService(makeConfig(dir, { WHATSAPP_MAX_INBOUND_ATTEMPTS: "3", WHATSAPP_BASE_RETRY_MS: "5" }), {
    failureInjector: async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("transient dependency failure");
      }
    }
  });
  const event = inbound();
  const first = await svc.ingest(event);
  assert.equal(first.event.processing_status, "retrying");
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && svc.store.getEvent(event.event_id).processing_status !== "processed") {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const recovered = svc.store.getEvent(event.event_id);
  assert.equal(recovered.processing_status, "processed");
  assert.equal(recovered.attempts, 2);
  assert.equal(svc.store.getMessages(recovered.conversation_id).length, 1);
});
