import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DomainError, requireString, validateCampaign } from "../domain.mjs";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function asArray(value) {
  return Array.isArray(value) ? [...new Set(value.map((x) => String(x).trim()).filter(Boolean))] : [];
}

function bounded(value, fallback = 50, max = 100) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback;
}

function normalizePhone(value) {
  const phone = requireString(value, "phone").replace(/[\s()-]/g, "");
  if (!/^\+?[1-9]\d{6,15}$/.test(phone)) {
    throw new DomainError("invalid_phone", "phone must be an E.164-like international number", 422);
  }
  return phone.startsWith("+") ? phone : "+" + phone;
}

function assertVersion(current, expected) {
  if (!Number.isInteger(expected)) {
    throw new DomainError("expected_version_required", "expected_version must be an integer", 428);
  }
  if (current.version !== expected) {
    throw new DomainError("stale_version", "record version changed; refresh and retry", 409, {
      expected_version: expected,
      current_version: current.version
    });
  }
}

export class BusinessStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.ledgerPath = path.join(dataDir, "business-ledger.jsonl");
    this.contacts = new Map();
    this.templates = new Map();
    this.campaigns = new Map();
    this.sequence = 0;
    this.initialized = false;
    this.writeTail = Promise.resolve();
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
    const encoded = JSON.stringify(record) + "\n";
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
  }

  #apply(record) {
    const d = record.data;
    if (record.type === "contact.upsert") this.contacts.set(d.contact.contact_id, clone(d.contact));
    else if (record.type === "template.upsert") this.templates.set(d.template.template_id, clone(d.template));
    else if (record.type === "campaign.upsert") this.campaigns.set(d.campaign.campaign_id, clone(d.campaign));
    else throw new Error("unknown business ledger record type: " + record.type);
  }

  async upsertContact(identity, input = {}) {
    await this.init();
    const now = new Date().toISOString();
    const id = input.contact_id || "wa_contact_" + crypto.randomUUID();
    const current = this.contacts.get(id);
    if (current) assertVersion(current, input.expected_version);
    if (current && current.tenant_id !== identity.tenantId) {
      throw new DomainError("contact_not_found", "contact not found", 404);
    }
    const contact = {
      contact_id: id,
      tenant_id: identity.tenantId,
      name: requireString(input.name, "name"),
      phone: normalizePhone(input.phone),
      consent_status: ["opted_in", "unknown", "opted_out"].includes(input.consent_status)
        ? input.consent_status
        : (current?.consent_status || "unknown"),
      suppressed: input.suppressed === true,
      opted_out: input.opted_out === true || input.consent_status === "opted_out",
      tags: asArray(input.tags),
      notes: typeof input.notes === "string" ? input.notes.slice(0, 4000) : "",
      owner_id: input.owner_id ? String(input.owner_id) : current?.owner_id || null,
      version: (current?.version || 0) + 1,
      created_at: current?.created_at || now,
      updated_at: now,
      updated_by: identity.subject
    };
    await this.append("contact.upsert", { contact });
    return clone(contact);
  }

  listContacts(identity, query = {}) {
    let items = [...this.contacts.values()].filter((x) => x.tenant_id === identity.tenantId);
    const needle = String(query.q || "").trim().toLowerCase();
    if (needle) {
      items = items.filter((x) => [x.name, x.phone, ...(x.tags || [])]
        .some((v) => String(v || "").toLowerCase().includes(needle)));
    }
    if (query.consent_status) items = items.filter((x) => x.consent_status === query.consent_status);
    if (query.suppressed === "true") items = items.filter((x) => x.suppressed === true);
    items.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.contact_id.localeCompare(b.contact_id));
    const limit = bounded(query.limit);
    return { total: items.length, items: items.slice(0, limit).map(clone) };
  }

  getContact(identity, id) {
    const item = this.contacts.get(id);
    if (!item || item.tenant_id !== identity.tenantId) {
      throw new DomainError("contact_not_found", "contact not found", 404);
    }
    return clone(item);
  }

  async upsertTemplate(identity, input = {}) {
    await this.init();
    const now = new Date().toISOString();
    const id = input.template_id || "wa_tpl_" + crypto.randomUUID();
    const current = this.templates.get(id);
    if (current) assertVersion(current, input.expected_version);
    if (current && current.tenant_id !== identity.tenantId) {
      throw new DomainError("template_not_found", "template not found", 404);
    }
    const status = ["draft", "approved", "paused", "rejected"].includes(input.status)
      ? input.status
      : (current?.status || "draft");
    const template = {
      template_id: id,
      tenant_id: identity.tenantId,
      name: requireString(input.name, "name"),
      language: requireString(input.language || current?.language || "en", "language"),
      category: requireString(input.category || current?.category || "utility", "category"),
      status,
      body: requireString(input.body, "body"),
      variables: asArray(input.variables),
      version: (current?.version || 0) + 1,
      created_at: current?.created_at || now,
      updated_at: now,
      updated_by: identity.subject
    };
    await this.append("template.upsert", { template });
    return clone(template);
  }

  listTemplates(identity, query = {}) {
    let items = [...this.templates.values()].filter((x) => x.tenant_id === identity.tenantId);
    if (query.status) items = items.filter((x) => x.status === query.status);
    const needle = String(query.q || "").trim().toLowerCase();
    if (needle) {
      items = items.filter((x) => [x.name, x.body, x.category]
        .some((v) => String(v).toLowerCase().includes(needle)));
    }
    items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { total: items.length, items: items.slice(0, bounded(query.limit)).map(clone) };
  }

  getTemplate(identity, id) {
    const item = this.templates.get(id);
    if (!item || item.tenant_id !== identity.tenantId) {
      throw new DomainError("template_not_found", "template not found", 404);
    }
    return clone(item);
  }

  async upsertCampaign(identity, input = {}) {
    await this.init();
    const now = new Date().toISOString();
    const id = input.campaign_id || "wa_cmp_" + crypto.randomUUID();
    const current = this.campaigns.get(id);
    if (current) assertVersion(current, input.expected_version);
    if (current && current.tenant_id !== identity.tenantId) {
      throw new DomainError("campaign_not_found", "campaign not found", 404);
    }
    const status = ["draft", "ready", "paused", "completed", "cancelled"].includes(input.status)
      ? input.status
      : (current?.status || "draft");
    const templateId = requireString(input.template_id || current?.template_id, "template_id");
    const template = this.templates.get(templateId);
    if (!template || template.tenant_id !== identity.tenantId) {
      throw new DomainError("template_not_found", "template not found", 404);
    }
    const validationInput = {
      owner_id: input.owner_id || current?.owner_id || identity.subject,
      template_id: templateId,
      audience_count: Number.isInteger(input.audience_count) ? input.audience_count : (current?.audience_count || 0),
      bulk_approved: input.bulk_approved === true
    };
    const validation = validateCampaign(validationInput);
    if (status === "ready" && !validation.valid) {
      throw new DomainError("campaign_invalid", "campaign cannot enter ready state", 422, { errors: validation.errors });
    }
    const campaign = {
      campaign_id: id,
      tenant_id: identity.tenantId,
      name: requireString(input.name || current?.name, "name"),
      template_id: templateId,
      owner_id: validationInput.owner_id,
      audience_count: validationInput.audience_count,
      bulk_approved: validationInput.bulk_approved,
      status,
      scheduled_at: input.scheduled_at || current?.scheduled_at || null,
      validation,
      version: (current?.version || 0) + 1,
      created_at: current?.created_at || now,
      updated_at: now,
      updated_by: identity.subject
    };
    await this.append("campaign.upsert", { campaign });
    return clone(campaign);
  }

  listCampaigns(identity, query = {}) {
    let items = [...this.campaigns.values()].filter((x) => x.tenant_id === identity.tenantId);
    if (query.status) items = items.filter((x) => x.status === query.status);
    const needle = String(query.q || "").trim().toLowerCase();
    if (needle) {
      items = items.filter((x) => [x.name, x.campaign_id]
        .some((v) => String(v).toLowerCase().includes(needle)));
    }
    items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { total: items.length, items: items.slice(0, bounded(query.limit)).map(clone) };
  }

  getCampaign(identity, id) {
    const item = this.campaigns.get(id);
    if (!item || item.tenant_id !== identity.tenantId) {
      throw new DomainError("campaign_not_found", "campaign not found", 404);
    }
    return clone(item);
  }

  summary(identity) {
    const contacts = [...this.contacts.values()].filter((x) => x.tenant_id === identity.tenantId);
    const templates = [...this.templates.values()].filter((x) => x.tenant_id === identity.tenantId);
    const campaigns = [...this.campaigns.values()].filter((x) => x.tenant_id === identity.tenantId);
    return {
      contacts: {
        total: contacts.length,
        opted_in: contacts.filter((x) => x.consent_status === "opted_in" && !x.suppressed && !x.opted_out).length,
        suppressed: contacts.filter((x) => x.suppressed || x.opted_out).length
      },
      templates: {
        total: templates.length,
        approved: templates.filter((x) => x.status === "approved").length,
        draft: templates.filter((x) => x.status === "draft").length
      },
      campaigns: {
        total: campaigns.length,
        draft: campaigns.filter((x) => x.status === "draft").length,
        ready: campaigns.filter((x) => x.status === "ready").length,
        paused: campaigns.filter((x) => x.status === "paused").length
      }
    };
  }
}
