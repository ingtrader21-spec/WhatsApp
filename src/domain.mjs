export class DomainError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function evaluateEligibility(input = {}) {
  const reasons = [];
  if (input.suppressed === true) reasons.push("suppressed");
  if (input.opted_out === true) reasons.push("opted_out");
  if (input.consent_status !== "opted_in") reasons.push("consent_not_opted_in");
  if (typeof input.recipient !== "string" || input.recipient.trim() === "") reasons.push("recipient_missing");

  return {
    eligible: reasons.length === 0,
    reasons,
    policy: "codestra-whatsapp-strict-opt-in.v1"
  };
}

export function validateCampaign(input = {}) {
  const errors = [];
  if (typeof input.owner_id !== "string" || input.owner_id.trim() === "") errors.push("owner_id_required");
  if (typeof input.template_id !== "string" || input.template_id.trim() === "") errors.push("template_id_required");
  if (!Number.isInteger(input.audience_count) || input.audience_count < 1) errors.push("audience_count_invalid");
  if (input.audience_count > 1 && input.bulk_approved !== true) errors.push("bulk_approval_required");

  return {
    valid: errors.length === 0,
    errors,
    policy: "codestra-campaign-validation.v1"
  };
}

export function requireString(value, name, min = 1) {
  if (typeof value !== "string" || value.trim().length < min) {
    throw new DomainError("invalid_request", `${name} is required`, 400);
  }
  return value.trim();
}
