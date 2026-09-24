import crypto from "node:crypto";
import { DomainError, requireString } from "../domain.mjs";
import { DurableConversationStore } from "./store.mjs";
import { W3Metrics } from "./metrics.mjs";

const ALLOWED_TRANSITIONS = Object.freeze({
  new: new Set(["active", "waiting_agent", "escalated", "resolved"]),
  active: new Set(["waiting_customer", "waiting_agent", "escalated", "resolved"]),
  waiting_customer: new Set(["active", "waiting_agent", "escalated", "resolved"]),
  waiting_agent: new Set(["active", "escalated", "resolved"]),
  escalated: new Set(["active", "waiting_agent", "resolved"]),
  resolved: new Set(["reopened"]),
  reopened: new Set(["active", "waiting_agent", "escalated", "resolved"])
});

const OPTOUT = /^\s*(stop|unsubscribe|cancel|end|quit|remove\s+me|no\s+more)\s*[.!]?\s*$/i;
const HUMAN = /\b(agent|human|representative|person|supervisor|live\s+support)\b/i;

function hash(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentFingerprint(content) {
  return hash(stableJson(content));
}

function conversationIdFor(event) {
  return `wa_${hash(`${event.tenant_id}\n${event.sender_identity}\n${event.recipient_identity}`).slice(0, 32)}`;
}

function uuidLike(value, name) {
  requireString(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("invalid_event", `${name} must be a UUID`, 400);
  }
}

export function validateInboundEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new DomainError("invalid_event", "event object is required", 400);
  if (event.schema_version !== "whatsapp.inbound.v1") throw new DomainError("unsupported_event_schema", "schema_version must be whatsapp.inbound.v1", 422);
  uuidLike(event.event_id, "event_id");
  uuidLike(event.correlation_id, "correlation_id");
  uuidLike(event.tenant_id, "tenant_id");
  requireString(event.provider_event_id, "provider_event_id");
  requireString(event.sender_identity, "sender_identity");
  requireString(event.recipient_identity, "recipient_identity");
  if (event.channel !== "whatsapp") throw new DomainError("invalid_event", "channel must be whatsapp", 422);
  const allowedTypes = new Set(["message.received", "message.status", "conversation.updated", "contact.updated"]);
  if (!allowedTypes.has(event.event_type)) throw new DomainError("invalid_event", "unsupported event_type", 422);
  if (!/^\d{4}-\d\d-\d\dT/.test(String(event.provider_timestamp || "")) || Number.isNaN(Date.parse(event.provider_timestamp))) throw new DomainError("invalid_event", "provider_timestamp must be RFC3339", 422);
  if (!/^\d{4}-\d\d-\d\dT/.test(String(event.ingested_at || "")) || Number.isNaN(Date.parse(event.ingested_at))) throw new DomainError("invalid_event", "ingested_at must be RFC3339", 422);
  if (!/^[a-f0-9]{64}$/.test(String(event.payload_hash || ""))) throw new DomainError("invalid_event", "payload_hash must be lowercase sha256", 422);
  if (!event.content || typeof event.content !== "object" || typeof event.content.type !== "string") throw new DomainError("invalid_event", "content.type is required", 422);
  return { ...structuredClone(event), content_fingerprint: contentFingerprint(event.content) };
}

function nextRetry(attempt, baseRetryMs) {
  const delay = Math.min(baseRetryMs * (2 ** Math.max(0, attempt - 1)), 300_000);
  return new Date(Date.now() + delay).toISOString();
}

export class ConversationService {
  constructor(config, options = {}) {
    this.config = config;
    this.store = options.store || new DurableConversationStore({ dataDir: config.dataDir });
    this.metrics = options.metrics || new W3Metrics();
    this.failureInjector = options.failureInjector || null;
    this.ingressLocks = new Map();
    this.retryTimers = new Map();
    this.readyPromise = this.#initialize();
  }

  async #initialize() {
    await this.store.init();
    this.#refreshGauges();
    await this.recoverPending();
  }

  async ready() { await this.readyPromise; }

  #refreshGauges() {
    const stats = this.store.stats();
    this.metrics.set("codestra_whatsapp_w3_conversations", {}, stats.conversations);
    this.metrics.set("codestra_whatsapp_w3_dead_letters", {}, stats.dead_letters);
    this.metrics.set("codestra_whatsapp_w3_pending_automations", {}, stats.pending_automations);
  }

  async #audit({ tenantId, actorId, action, conversationId = null, eventId = null, reason = null, metadata = {} }) {
    const audit = {
      audit_id: crypto.randomUUID(), tenant_id: tenantId, actor_id: actorId,
      action, conversation_id: conversationId, event_id: eventId,
      reason, metadata, created_at: new Date().toISOString()
    };
    await this.store.append("audit.append", { audit });
    return audit;
  }

  async #withIngressLock(key, fn) {
    const previous = this.ingressLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.ingressLocks.set(key, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.ingressLocks.get(key) === chain) this.ingressLocks.delete(key);
    }
  }

  #clearRetryTimer(eventId) {
    const timer = this.retryTimers.get(eventId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(eventId);
  }

  #scheduleRetry(eventId, nextAttemptAt) {
    this.#clearRetryTimer(eventId);
    const due = Date.parse(nextAttemptAt);
    const delay = Number.isFinite(due) ? Math.max(0, due - Date.now()) : 0;
    const timer = setTimeout(async () => {
      this.retryTimers.delete(eventId);
      const event = this.store.getEvent(eventId);
      if (!event || event.processing_status !== "retrying") return;
      try {
        await this.#attemptProcess(eventId);
        this.#refreshGauges();
      } catch {
        // #attemptProcess persists retry/dead-letter state; unexpected failures remain visible in durable status.
      }
    }, Math.min(delay, 300_000));
    timer.unref?.();
    this.retryTimers.set(eventId, timer);
  }

  async ingest(rawEvent) {
    await this.ready();
    const event = validateInboundEvent(rawEvent);
    const ingressKey = `${event.tenant_id}:${event.provider_event_id}`;
    return this.#withIngressLock(ingressKey, async () => {
      const existing = this.store.getEventByProvider(event.tenant_id, event.provider_event_id);
      if (existing) {
        if (existing.payload_hash !== event.payload_hash || existing.content_fingerprint !== event.content_fingerprint) {
          this.metrics.inc("codestra_whatsapp_w3_conflicting_duplicates_total", { tenant: event.tenant_id });
          await this.#audit({ tenantId: event.tenant_id, actorId: "system:ingress", action: "inbound.conflicting_duplicate", eventId: existing.event_id, reason: "provider_event_id_payload_mismatch" });
          throw new DomainError("conflicting_duplicate", "provider event ID already exists with different normalized content", 409);
        }
        this.metrics.inc("codestra_whatsapp_w3_duplicates_total", { tenant: event.tenant_id });
        return { duplicate: true, event: existing, conversation: existing.conversation_id ? this.store.getConversation(existing.conversation_id) : null };
      }

      const accepted = {
        ...event,
        processing_status: "accepted",
        attempts: 0,
        next_attempt_at: null,
        last_error: null,
        conversation_id: null,
        processed_at: null
      };
      await this.store.append("inbound.accepted", { event: accepted });
      this.metrics.inc("codestra_whatsapp_w3_inbound_events_total", { tenant: event.tenant_id, event_type: event.event_type });
      const result = await this.#attemptProcess(event.event_id);
      this.#refreshGauges();
      return { duplicate: false, ...result };
    });
  }

  async #attemptProcess(eventId, { replay = false } = {}) {
    this.#clearRetryTimer(eventId);
    const event = this.store.getEvent(eventId);
    if (!event) throw new DomainError("event_not_found", "event not found", 404);
    const attempt = Number(event.attempts || 0) + 1;
    await this.store.append("inbound.status", { event_id: eventId, patch: { processing_status: "processing", attempts: attempt, next_attempt_at: null } });
    try {
      if (this.failureInjector) await this.failureInjector(event, attempt, replay);
      const conversation = await this.#process(event);
      const processedAt = new Date().toISOString();
      await this.store.append("inbound.status", { event_id: eventId, patch: { processing_status: "processed", processed_at: processedAt, last_error: null, conversation_id: conversation?.conversation_id || event.conversation_id || null } });
      this.metrics.inc("codestra_whatsapp_w3_processed_events_total", { tenant: event.tenant_id });
      return { event: this.store.getEvent(eventId), conversation };
    } catch (error) {
      const retryable = !(error instanceof DomainError && error.status >= 400 && error.status < 500);
      const exhausted = attempt >= this.config.maxInboundAttempts;
      if (!retryable || exhausted) {
        const deadLetter = {
          dead_letter_id: crypto.randomUUID(), tenant_id: event.tenant_id, event_id: event.event_id,
          provider_event_id: event.provider_event_id, reason: error.code || "processing_error",
          message: error.message, attempts: attempt, replay_count: 0,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        };
        await this.store.append("deadletter.upsert", { dead_letter: deadLetter });
        await this.store.append("inbound.status", { event_id: eventId, patch: { processing_status: "dead_letter", last_error: deadLetter.reason, next_attempt_at: null } });
        this.metrics.inc("codestra_whatsapp_w3_dead_lettered_total", { tenant: event.tenant_id, reason: deadLetter.reason });
        await this.#audit({ tenantId: event.tenant_id, actorId: "system:processor", action: "inbound.dead_lettered", eventId, reason: deadLetter.reason });
        return { event: this.store.getEvent(eventId), dead_letter: deadLetter, conversation: null };
      }
      const next = nextRetry(attempt, this.config.baseRetryMs);
      await this.store.append("inbound.status", { event_id: eventId, patch: { processing_status: "retrying", last_error: error.code || "processing_error", next_attempt_at: next } });
      this.metrics.inc("codestra_whatsapp_w3_retries_total", { tenant: event.tenant_id });
      this.#scheduleRetry(eventId, next);
      return { event: this.store.getEvent(eventId), retrying: true, conversation: null };
    }
  }

  async #process(event) {
    if (event.event_type !== "message.received") {
      await this.#audit({ tenantId: event.tenant_id, actorId: "system:processor", action: `inbound.${event.event_type}.observed`, eventId: event.event_id });
      return event.conversation_id ? this.store.getConversation(event.conversation_id) : null;
    }
    const conversationId = conversationIdFor(event);
    return this.store.withConversationLock(conversationId, async () => {
      let conversation = this.store.getConversation(conversationId);
      if (conversation && this.store.getMessageByEvent(conversationId, event.event_id)) {
        await this.#audit({ tenantId: event.tenant_id, actorId: "system:processor", action: "inbound.reprocess_suppressed", conversationId, eventId: event.event_id, reason: "message_already_materialized" });
        return conversation;
      }
      const now = new Date().toISOString();
      if (!conversation) {
        conversation = {
          conversation_id: conversationId,
          tenant_id: event.tenant_id,
          channel: "whatsapp",
          customer_identity: event.sender_identity,
          business_identity: event.recipient_identity,
          status: "new",
          version: 0,
          assigned_to: null,
          assigned_team: null,
          automation_paused: false,
          unread_count: 0,
          last_inbound_at: null,
          last_outbound_at: null,
          sla_due_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          sla_breached: false,
          created_at: now,
          updated_at: now
        };
      }
      if (conversation.status === "new") {
        conversation = await this.#transitionObject(conversation, "active", { reason: "inbound_message", actorId: "system:processor", eventId: event.event_id });
      } else if (conversation.status === "resolved") {
        conversation = await this.#transitionObject(conversation, "reopened", { reason: "new_inbound_after_resolution", actorId: "system:processor", eventId: event.event_id });
        conversation = await this.#transitionObject(conversation, "active", { reason: "inbound_message", actorId: "system:processor", eventId: event.event_id });
      }
      conversation.unread_count += 1;
      if (!conversation.last_inbound_at || Date.parse(event.provider_timestamp) >= Date.parse(conversation.last_inbound_at)) {
        conversation.last_inbound_at = event.provider_timestamp;
      }
      conversation.updated_at = now;
      conversation.version += 1;
      await this.store.append("conversation.upsert", { conversation });

      const message = {
        message_id: crypto.randomUUID(), tenant_id: event.tenant_id, conversation_id: conversationId,
        direction: "inbound", visibility: "customer", event_id: event.event_id,
        content: event.content, created_at: now
      };
      await this.store.append("message.append", { message });
      await this.store.append("inbound.status", { event_id: event.event_id, patch: { conversation_id: conversationId } });

      const text = event.content.type === "text" ? String(event.content.text || "") : "";
      if (OPTOUT.test(text)) {
        const request = {
          suppression_request_id: crypto.randomUUID(), tenant_id: event.tenant_id,
          channel_identity: event.sender_identity, source: "conversation_opt_out",
          event_id: event.event_id, conversation_id: conversationId, created_at: now
        };
        await this.store.append("suppression.requested", { request });
        conversation.automation_paused = true;
        conversation.version += 1;
        conversation.updated_at = now;
        await this.store.append("conversation.upsert", { conversation });
        await this.#cancelPendingAutomation(conversation, "opt_out");
        await this.#audit({ tenantId: event.tenant_id, actorId: "system:policy", action: "suppression.requested", conversationId, eventId: event.event_id, reason: "customer_opt_out" });
        return conversation;
      }

      if (HUMAN.test(text)) {
        conversation = await this.#ensureState(conversation, "waiting_agent", "customer_requested_human", "system:routing", event.event_id);
        await this.#cancelPendingAutomation(conversation, "human_handoff");
        await this.#audit({ tenantId: event.tenant_id, actorId: "system:routing", action: "handoff.requested", conversationId, eventId: event.event_id, reason: "customer_requested_human" });
        return conversation;
      }

      const automation = {
        automation_id: crypto.randomUUID(), tenant_id: event.tenant_id, conversation_id: conversationId,
        event_id: event.event_id, conversation_version: conversation.version,
        status: this.config.aiAutoreply && !conversation.automation_paused ? "pending" : "skipped",
        action: this.config.aiAutoreply && !conversation.automation_paused ? "draft_response" : "none",
        confidence: null,
        reason: this.config.aiAutoreply ? (conversation.automation_paused ? "conversation_paused" : "policy_eligible") : "ai_autoreply_disabled",
        created_at: now, updated_at: now
      };
      await this.store.append("automation.decision", { automation });
      await this.#audit({ tenantId: event.tenant_id, actorId: "system:automation", action: "automation.decision", conversationId, eventId: event.event_id, reason: automation.reason, metadata: { automation_id: automation.automation_id, status: automation.status } });
      return this.store.getConversation(conversationId);
    });
  }

  async #transitionObject(conversation, target, { reason, actorId, eventId = null, allowSame = false }) {
    if (conversation.status === target && allowSame) return conversation;
    if (!ALLOWED_TRANSITIONS[conversation.status]?.has(target)) {
      throw new DomainError("invalid_state_transition", `cannot transition ${conversation.status} -> ${target}`, 409);
    }
    const updated = { ...conversation, status: target, version: conversation.version + 1, updated_at: new Date().toISOString() };
    await this.store.append("conversation.upsert", { conversation: updated });
    await this.#audit({ tenantId: updated.tenant_id, actorId, action: "conversation.transition", conversationId: updated.conversation_id, eventId, reason, metadata: { from: conversation.status, to: target, version: updated.version } });
    return updated;
  }

  async #ensureState(conversation, target, reason, actorId, eventId = null) {
    if (conversation.status === target) return conversation;
    return this.#transitionObject(conversation, target, { reason, actorId, eventId });
  }

  async #cancelPendingAutomation(conversation, reason) {
    for (const automation of this.store.listAutomationsForConversation(conversation.conversation_id)) {
      if (automation.status !== "pending") continue;
      const updated = { ...automation, status: "cancelled", reason, updated_at: new Date().toISOString() };
      await this.store.append("automation.updated", { automation: updated });
    }
    this.#refreshGauges();
  }

  async recoverPending() {
    await this.store.init();
    const pending = [...this.store.events.values()].filter((e) => ["accepted", "retrying", "processing"].includes(e.processing_status));
    for (const event of pending) {
      if (event.processing_status === "retrying" && event.next_attempt_at && Date.parse(event.next_attempt_at) > Date.now()) {
        this.#scheduleRetry(event.event_id, event.next_attempt_at);
        continue;
      }
      await this.#attemptProcess(event.event_id);
    }
  }

  listConversations(identity, query) {
    const requestedLimit = Number(query.limit || 50);
    const limit = Math.max(1, Math.min(this.config.maxPageSize, Number.isFinite(requestedLimit) ? requestedLimit : 50));
    let offset = 0;
    if (query.cursor) {
      try { offset = Number(Buffer.from(query.cursor, "base64url").toString("utf8")); } catch { throw new DomainError("invalid_cursor", "cursor is invalid", 400); }
      if (!Number.isInteger(offset) || offset < 0) throw new DomainError("invalid_cursor", "cursor is invalid", 400);
    }
    const result = this.store.listConversations({ tenantId: identity.tenantId, status: query.status || null, assignedTo: query.assigned_to || null, query: query.q || null, offset, limit });
    return {
      items: result.items,
      next_cursor: offset + result.items.length < result.total ? Buffer.from(String(offset + result.items.length)).toString("base64url") : null
    };
  }

  getConversation(identity, id) {
    const conversation = this.store.requireConversationTenant(id, identity.tenantId);
    return { ...conversation, assignment_history: this.store.getAssignments(id) };
  }

  timeline(identity, id) {
    this.store.requireConversationTenant(id, identity.tenantId);
    return this.store.timeline(id);
  }

  #assertVersion(conversation, expectedVersion) {
    if (!Number.isInteger(expectedVersion)) throw new DomainError("expected_version_required", "expected_version must be an integer", 428);
    if (conversation.version !== expectedVersion) {
      throw new DomainError("stale_conversation_version", "conversation version changed; refresh and retry", 409, { expected_version: expectedVersion, current_version: conversation.version });
    }
  }

  async claim(identity, id, expectedVersion) {
    return this.assign(identity, id, { actor_id: identity.subject, team: null, reason: "agent_claim", expected_version: expectedVersion });
  }

  async assign(identity, id, { actor_id, team = null, reason = "manual_assignment", expected_version }) {
    return this.store.withConversationLock(id, async () => {
      let conversation = this.store.requireConversationTenant(id, identity.tenantId);
      this.#assertVersion(conversation, expected_version);
      conversation = await this.#ensureState(conversation, "waiting_agent", reason, identity.subject);
      conversation.assigned_to = requireString(actor_id, "actor_id");
      conversation.assigned_team = team ? requireString(team, "team") : null;
      conversation.automation_paused = true;
      conversation.version += 1;
      conversation.updated_at = new Date().toISOString();
      await this.store.append("conversation.upsert", { conversation });
      const assignment = {
        assignment_id: crypto.randomUUID(), tenant_id: identity.tenantId, conversation_id: id,
        assigned_to: conversation.assigned_to, assigned_team: conversation.assigned_team,
        assigned_by: identity.subject, reason, created_at: conversation.updated_at
      };
      await this.store.append("assignment.changed", { assignment });
      await this.#cancelPendingAutomation(conversation, "human_takeover");
      await this.#audit({ tenantId: identity.tenantId, actorId: identity.subject, action: "conversation.assigned", conversationId: id, reason, metadata: { assigned_to: conversation.assigned_to, assigned_team: conversation.assigned_team } });
      this.metrics.inc("codestra_whatsapp_w3_handoffs_total", { tenant: identity.tenantId });
      return conversation;
    });
  }

  async escalate(identity, id, reason, expectedVersion) {
    return this.store.withConversationLock(id, async () => {
      let conversation = this.store.requireConversationTenant(id, identity.tenantId);
      this.#assertVersion(conversation, expectedVersion);
      conversation = await this.#ensureState(conversation, "escalated", requireString(reason, "reason"), identity.subject);
      conversation.automation_paused = true;
      conversation.version += 1;
      conversation.updated_at = new Date().toISOString();
      await this.store.append("conversation.upsert", { conversation });
      await this.#cancelPendingAutomation(conversation, "escalated");
      this.metrics.inc("codestra_whatsapp_w3_escalations_total", { tenant: identity.tenantId });
      return conversation;
    });
  }

  async resolve(identity, id, reason, expectedVersion) {
    return this.store.withConversationLock(id, async () => {
      let conversation = this.store.requireConversationTenant(id, identity.tenantId);
      this.#assertVersion(conversation, expectedVersion);
      conversation = await this.#ensureState(conversation, "resolved", requireString(reason, "reason"), identity.subject);
      conversation.resolved_reason = reason;
      conversation.resolved_at = new Date().toISOString();
      conversation.version += 1;
      await this.store.append("conversation.upsert", { conversation });
      return conversation;
    });
  }

  async reopen(identity, id, reason, expectedVersion) {
    return this.store.withConversationLock(id, async () => {
      let conversation = this.store.requireConversationTenant(id, identity.tenantId);
      this.#assertVersion(conversation, expectedVersion);
      conversation = await this.#ensureState(conversation, "reopened", requireString(reason, "reason"), identity.subject);
      conversation.resolved_reason = null;
      conversation.resolved_at = null;
      conversation.version += 1;
      await this.store.append("conversation.upsert", { conversation });
      return conversation;
    });
  }

  async setAutomationPaused(identity, id, paused, reason, expectedVersion) {
    return this.store.withConversationLock(id, async () => {
      const conversation = this.store.requireConversationTenant(id, identity.tenantId);
      this.#assertVersion(conversation, expectedVersion);
      const updated = { ...conversation, automation_paused: paused, version: conversation.version + 1, updated_at: new Date().toISOString() };
      await this.store.append("conversation.upsert", { conversation: updated });
      if (paused) await this.#cancelPendingAutomation(updated, reason || "manual_pause");
      await this.#audit({ tenantId: identity.tenantId, actorId: identity.subject, action: paused ? "automation.paused" : "automation.resumed", conversationId: id, reason: reason || null });
      return updated;
    });
  }

  listDeadLetters(identity) { return this.store.listDeadLetters(identity.tenantId); }

  async replayDeadLetter(identity, deadLetterId) {
    const dlq = this.store.getDeadLetter(deadLetterId);
    if (!dlq || dlq.tenant_id !== identity.tenantId) throw new DomainError("dead_letter_not_found", "dead letter not found", 404);
    const updated = { ...dlq, replay_count: dlq.replay_count + 1, updated_at: new Date().toISOString() };
    await this.store.append("deadletter.upsert", { dead_letter: updated });
    await this.#audit({ tenantId: identity.tenantId, actorId: identity.subject, action: "deadletter.replay", eventId: dlq.event_id, reason: "authorized_operator_replay", metadata: { dead_letter_id: deadLetterId, replay_count: updated.replay_count } });
    const result = await this.#attemptProcess(dlq.event_id, { replay: true });
    if (result.event.processing_status === "processed") await this.store.append("deadletter.delete", { dead_letter_id: deadLetterId });
    this.metrics.inc("codestra_whatsapp_w3_replays_total", { tenant: identity.tenantId });
    this.#refreshGauges();
    return result;
  }

  metricsText() { this.#refreshGauges(); return this.metrics.render(); }
}
