import crypto from "node:crypto";
import { DomainError, requireString } from "./domain.mjs";

export const AI_DRAFT_ACTIONS = Object.freeze([
  "suggest_reply",
  "rewrite",
  "shorter",
  "professional",
  "translate",
  "summarize",
  "knowledge_answer"
]);

function requireAction(value) {
  if (!AI_DRAFT_ACTIONS.includes(value)) {
    throw new DomainError("invalid_ai_action", "unsupported AI draft action", 400, { allowed: AI_DRAFT_ACTIONS });
  }
  return value;
}

function bounded(value, field, max = 12000) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new DomainError("invalid_request", field + " must be a string", 400);
  const text = value.trim();
  if (text.length > max) throw new DomainError("invalid_request", field + " is too long", 400);
  return text;
}

function conversationMessages(timeline = []) {
  return timeline
    .filter((entry) => entry?.type === "message" && entry?.data)
    .slice(-30)
    .map((entry) => ({
      direction: entry.data.direction,
      text: bounded(entry.data.content?.text || "[" + (entry.data.content?.type || "message") + "]", "timeline_text", 4000),
      created_at: entry.data.created_at
    }));
}

export function buildAiDraftCommand(identity, conversation, timeline, body = {}, now = new Date()) {
  const action = requireAction(body.action);
  const draft = bounded(body.draft, "draft", 8000);
  const language = bounded(body.language, "language", 80);
  const knowledgeQuery = bounded(body.knowledge_query, "knowledge_query", 2000);
  if (["rewrite", "shorter", "professional", "translate"].includes(action) && !draft) {
    throw new DomainError("draft_required", "draft is required for this AI action", 400);
  }
  if (action === "translate" && !language) {
    throw new DomainError("language_required", "language is required for translation", 400);
  }

  const requestedAt = now.toISOString();
  const deadlineAt = new Date(now.getTime() + 120_000).toISOString();
  const commandId = crypto.randomUUID();
  const correlationId = "wa-ai-" + crypto.randomUUID();
  const idempotencyKey = String(body.idempotency_key || ("wa-ai-" + crypto.randomUUID()));

  return {
    command_id: commandId,
    command_type: "ai.chat.v1",
    schema_version: "1.0",
    tenant_id: requireString(identity.tenantId, "tenant_id"),
    actor_id: requireString(identity.subject, "actor_id"),
    actor_type: "user",
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    priority: 5,
    requested_at: requestedAt,
    deadline_at: deadlineAt,
    input: {
      task: "whatsapp_agent_draft",
      action,
      channel: "whatsapp",
      conversation_id: conversation.conversation_id,
      customer_identity: conversation.customer_identity,
      business_identity: conversation.business_identity,
      messages: conversationMessages(timeline),
      current_draft: draft || null,
      target_language: language || null,
      knowledge_query: knowledgeQuery || null,
      response_contract: {
        output_field: "proposal",
        human_review_required: true,
        auto_send: false,
        no_provider_effects: true
      },
      instructions: [
        "Return only a draft suitable for a human WhatsApp agent to review.",
        "Do not claim an action, refund, booking, payment, policy exception, or external side effect occurred.",
        "Do not invent company facts. When knowledge is insufficient, say what information the agent should verify.",
        "Keep personally sensitive data out of the answer unless it is necessary to answer the customer's request."
      ]
    },
    model_policy: {
      profile: action === "knowledge_answer" ? "quality-chat" : "fast-chat",
      temperature: action === "summarize" ? 0.1 : 0.2,
      max_tokens: action === "summarize" ? 1200 : 800
    },
    resource_limits: {
      runtime_seconds: 120,
      output_bytes: 65536,
      retry_count: 2,
      token_budget: 8192
    },
    data_classification: "confidential",
    approval_policy: { required: false, action_types: [] },
    callback_policy: { mode: "poll" },
    metadata: {
      source: "codestra-whatsapp",
      mode: "human_review_draft",
      action
    }
  };
}

async function middlewareRequest(config, authorization, path, options = {}) {
  requireString(authorization, "Authorization");
  const url = new URL(config.middlewareAiPath.replace(/\/+$/, "") + path, config.middlewareBaseUrl).toString();
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization,
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = { raw }; }
  return { status: response.status, ok: response.ok, payload };
}

export async function submitAiDraft(config, authorization, command) {
  return middlewareRequest(config, authorization, "/commands", {
    method: "POST",
    headers: {
      "x-tenant-id": command.tenant_id,
      "x-correlation-id": command.correlation_id,
      "idempotency-key": command.idempotency_key
    },
    body: command
  });
}

export async function readAiDraft(config, authorization, commandId, result = false) {
  const id = encodeURIComponent(requireString(commandId, "command_id"));
  return middlewareRequest(config, authorization, "/commands/" + id + (result ? "/result" : ""), { method: "GET" });
}
