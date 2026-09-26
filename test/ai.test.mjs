import test from "node:test";
import assert from "node:assert/strict";
import { buildAiDraftCommand, AI_DRAFT_ACTIONS } from "../src/ai.mjs";

const identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  subject: "agent-123"
};
const conversation = {
  conversation_id: "conv-1",
  customer_identity: "+18095550100",
  business_identity: "+18095550999"
};
const timeline = [
  { type: "message", data: { direction: "inbound", content: { type: "text", text: "What are your prices?" }, created_at: "2026-09-25T20:00:00Z" } },
  { type: "assignment", data: { actor_id: "agent-123" } },
  { type: "message", data: { direction: "outbound", content: { type: "text", text: "I can help." }, created_at: "2026-09-25T20:01:00Z" } }
];

test("AI draft command is human-review-only and has no provider effect", () => {
  const command = buildAiDraftCommand(identity, conversation, timeline, { action: "suggest_reply" }, new Date("2026-09-25T20:02:00Z"));
  assert.equal(command.command_type, "ai.chat.v1");
  assert.equal(command.tenant_id, identity.tenantId);
  assert.equal(command.actor_id, identity.subject);
  assert.equal(command.input.response_contract.human_review_required, true);
  assert.equal(command.input.response_contract.auto_send, false);
  assert.equal(command.input.response_contract.no_provider_effects, true);
  assert.equal(command.approval_policy.required, false);
  assert.equal(command.input.messages.length, 2);
  assert.equal(command.metadata.mode, "human_review_draft");
});

test("rewrite-like actions require an agent draft", () => {
  for (const action of ["rewrite", "shorter", "professional", "translate"]) {
    assert.throws(
      () => buildAiDraftCommand(identity, conversation, timeline, { action }),
      /draft is required/
    );
  }
});

test("translation requires target language", () => {
  assert.throws(
    () => buildAiDraftCommand(identity, conversation, timeline, { action: "translate", draft: "Hello" }),
    /language is required/
  );
});

test("knowledge answers use quality chat and remain draft-only", () => {
  const command = buildAiDraftCommand(identity, conversation, timeline, {
    action: "knowledge_answer",
    knowledge_query: "pricing policy"
  });
  assert.equal(command.model_policy.profile, "quality-chat");
  assert.equal(command.input.knowledge_query, "pricing policy");
  assert.equal(command.input.response_contract.auto_send, false);
});

test("AI action surface is bounded", () => {
  assert.deepEqual(AI_DRAFT_ACTIONS, [
    "suggest_reply", "rewrite", "shorter", "professional", "translate", "summarize", "knowledge_answer"
  ]);
});
