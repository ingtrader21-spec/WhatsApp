import fs from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../domain.mjs";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class DurableConversationStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.ledgerPath = path.join(dataDir, "w3-ledger.jsonl");
    this.events = new Map();
    this.providerIndex = new Map();
    this.conversations = new Map();
    this.messages = new Map();
    this.assignments = new Map();
    this.automations = new Map();
    this.audit = [];
    this.deadLetters = new Map();
    this.suppressionRequests = new Map();
    this.sequence = 0;
    this.initialized = false;
    this.writeTail = Promise.resolve();
    this.locks = new Map();
  }

  async init() {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let raw = "";
    try {
      raw = await fs.readFile(this.ledgerPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      this.sequence = Math.max(this.sequence, Number(record.sequence) || 0);
      this.#apply(record);
    }
    this.initialized = true;
  }

  async append(type, data) {
    await this.init();
    const record = {
      sequence: ++this.sequence,
      recorded_at: new Date().toISOString(),
      type,
      data: clone(data)
    };
    const encoded = `${JSON.stringify(record)}\n`;
    this.writeTail = this.writeTail.then(async () => {
      const handle = await fs.open(this.ledgerPath, "a", 0o600);
      try {
        await handle.write(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#apply(record);
    });
    await this.writeTail;
    return clone(record);
  }

  #apply(record) {
    const d = record.data;
    switch (record.type) {
      case "inbound.accepted":
        this.events.set(d.event.event_id, clone(d.event));
        this.providerIndex.set(`${d.event.tenant_id}:${d.event.provider_event_id}`, d.event.event_id);
        break;
      case "inbound.status": {
        const event = this.events.get(d.event_id);
        if (event) Object.assign(event, clone(d.patch));
        break;
      }
      case "conversation.upsert":
        this.conversations.set(d.conversation.conversation_id, clone(d.conversation));
        break;
      case "message.append": {
        const list = this.messages.get(d.message.conversation_id) || [];
        list.push(clone(d.message));
        this.messages.set(d.message.conversation_id, list);
        break;
      }
      case "assignment.changed": {
        const list = this.assignments.get(d.assignment.conversation_id) || [];
        list.push(clone(d.assignment));
        this.assignments.set(d.assignment.conversation_id, list);
        break;
      }
      case "automation.decision":
      case "automation.updated":
        this.automations.set(d.automation.automation_id, clone(d.automation));
        break;
      case "audit.append":
        this.audit.push(clone(d.audit));
        break;
      case "deadletter.upsert":
        this.deadLetters.set(d.dead_letter.dead_letter_id, clone(d.dead_letter));
        break;
      case "deadletter.delete":
        this.deadLetters.delete(d.dead_letter_id);
        break;
      case "suppression.requested":
        this.suppressionRequests.set(`${d.request.tenant_id}:${d.request.channel_identity}`, clone(d.request));
        break;
      default:
        throw new Error(`unknown ledger record type: ${record.type}`);
    }
  }

  async withConversationLock(conversationId, fn) {
    const previous = this.locks.get(conversationId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.locks.set(conversationId, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(conversationId) === chain) this.locks.delete(conversationId);
    }
  }

  getEvent(eventId) { return clone(this.events.get(eventId)); }
  getEventByProvider(tenantId, providerEventId) {
    const id = this.providerIndex.get(`${tenantId}:${providerEventId}`);
    return id ? this.getEvent(id) : undefined;
  }
  getConversation(id) { return clone(this.conversations.get(id)); }
  getMessages(id) { return clone(this.messages.get(id) || []); }
  getMessageByEvent(id, eventId) { return clone((this.messages.get(id) || []).find((x) => x.event_id === eventId)); }
  getAssignments(id) { return clone(this.assignments.get(id) || []); }
  getAutomation(id) { return clone(this.automations.get(id)); }
  listAutomationsForConversation(id) { return [...this.automations.values()].filter((x) => x.conversation_id === id).map(clone); }
  getSuppressionRequest(tenantId, identity) { return clone(this.suppressionRequests.get(`${tenantId}:${identity}`)); }
  getDeadLetter(id) { return clone(this.deadLetters.get(id)); }

  listDeadLetters(tenantId) {
    return [...this.deadLetters.values()].filter((x) => x.tenant_id === tenantId).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(clone);
  }

  listConversations({ tenantId, status, assignedTo, query, offset = 0, limit = 50 }) {
    let items = [...this.conversations.values()].filter((x) => x.tenant_id === tenantId);
    if (status) items = items.filter((x) => x.status === status);
    if (assignedTo) items = items.filter((x) => x.assigned_to === assignedTo);
    if (query) {
      const needle = query.toLowerCase();
      items = items.filter((x) => [x.customer_identity, x.business_identity, x.conversation_id].some((v) => String(v || "").toLowerCase().includes(needle)));
    }
    items.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.conversation_id.localeCompare(b.conversation_id));
    return {
      total: items.length,
      items: items.slice(offset, offset + limit).map(clone)
    };
  }

  timeline(conversationId) {
    const messages = this.getMessages(conversationId).map((x) => ({ type: "message", at: x.created_at, data: x }));
    const assignments = this.getAssignments(conversationId).map((x) => ({ type: "assignment", at: x.created_at, data: x }));
    const automations = this.listAutomationsForConversation(conversationId).map((x) => ({ type: "automation", at: x.updated_at || x.created_at, data: x }));
    const audit = this.audit.filter((x) => x.conversation_id === conversationId).map((x) => ({ type: "audit", at: x.created_at, data: clone(x) }));
    return [...messages, ...assignments, ...automations, ...audit].sort((a, b) => a.at.localeCompare(b.at));
  }

  stats() {
    return {
      events: this.events.size,
      conversations: this.conversations.size,
      dead_letters: this.deadLetters.size,
      pending_automations: [...this.automations.values()].filter((x) => x.status === "pending").length
    };
  }

  requireConversationTenant(conversationId, tenantId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new DomainError("conversation_not_found", "conversation not found", 404);
    if (conversation.tenant_id !== tenantId) throw new DomainError("conversation_not_found", "conversation not found", 404);
    return conversation;
  }
}
