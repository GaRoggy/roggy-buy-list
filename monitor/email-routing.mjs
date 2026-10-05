/* Deterministic Gmail routing policy. Provider text is data; this module has
 * no action capability and never sends anything back to Gmail. */

import { assessEmail } from './email-semantics.mjs';

export const EMAIL_ROUTING_VERSION = 'email-routing-v3';
export const ROUTING_POLICY_VERSION = EMAIL_ROUTING_VERSION;

export const DEFAULT_ROUTING_THRESHOLDS = Object.freeze({
  dashboardActionConfidence: 0.74,
  dashboardReplyConfidence: 0.78,
  financeConfidence: 0.80,
  hiddenLowValueConfidence: 0.84,
  mailImportance: 0.50,
  mailConfidenceFloor: 0.80,
});

function bool(value) { return value === true; }

export function routeAssessment(assessment = {}, { thresholds = DEFAULT_ROUTING_THRESHOLDS, due_date = null } = {}) {
  const a = assessment;
  const t = { ...DEFAULT_ROUTING_THRESHOLDS, ...(thresholds || {}) };
  const ambiguous = Array.isArray(a.ambiguity_reason) && a.ambiguity_reason.length > 0;
  const conflict = a.semantic_status === 'model_conflict' || a.ambiguity_reason?.some(reason => reason.startsWith('conflict:'));
  let route = 'hidden';
  let reason = null;
  const hardLowValue = a.low_value && (Number(a.low_value_confidence) >= 0.92 || a.evidence?.includes('provider_low_value_label'));
  if (hardLowValue || (a.low_value && Number(a.low_value_confidence) >= t.hiddenLowValueConfidence && !a.action_required && !a.needs_reply)) {
    route = 'hidden';
    reason = 'Low-value provider or marketing signal with no pending action.';
  } else if ((a.action_required && Number(a.action_confidence) >= t.dashboardActionConfidence) ||
    (a.needs_reply && Number(a.reply_confidence) >= t.dashboardReplyConfidence)) {
    route = 'dashboard';
    reason = a.needs_reply ? 'A person appears to be awaiting a reply.' : (due_date ? `Action may be due ${due_date}.` : 'Action required.');
  } else if (a.finance_related && !a.action_required && !a.needs_reply && Number(a.finance_confidence) >= t.financeConfidence) {
    route = 'finance';
    reason = 'Financial information to review later.';
  } else if (a.importance || Number(a.importance_score) >= t.mailImportance || ambiguous) {
    route = 'mail';
    reason = conflict ? 'Evidence conflicts; review recommended.' : 'Possibly important; review recommended.';
  }
  const relevant = route === 'dashboard'
    ? (a.needs_reply ? a.reply_confidence : a.action_confidence)
    : route === 'finance' ? a.finance_confidence
      : route === 'hidden' ? a.low_value_confidence : Math.min(a.importance_confidence || 0, a.route_confidence || 1);
  const route_confidence = Number(Math.max(0, Math.min(1, Number(relevant) || 0)).toFixed(3));
  return { route, reason, route_confidence, ambiguity_reason: Array.isArray(a.ambiguity_reason) ? a.ambiguity_reason : [],
    routing_version: EMAIL_ROUTING_VERSION, routing_policy_version: ROUTING_POLICY_VERSION };
}

export function detectNeedsReply({ text = '', headers = {}, sender = '', category = '', thread_context = {} } = {}) {
  return assessEmail({ category, headers, sender, text, thread_context }).needs_reply;
}

export function routeEmail({
  category = 'unimportant', labels = [], text = '', headers = {}, sender = '',
  subject = '', due_date = null, required_action = null, thread_context = {}, thresholds,
} = {}) {
  const assessment = assessEmail({ category, labels, text, headers, sender, subject, due_date, required_action, thread_context });
  const baseImportance = Number.isFinite(Number(assessment.importance_score)) ? Number(assessment.importance_score) : (assessment.importance ? 0.6 : 0.1);
  const routed = routeAssessment({ ...assessment, importance_score: baseImportance }, { thresholds, due_date });
  return { ...assessment, importance_score: baseImportance, ...routed,
    action_required: bool(assessment.action_required), needs_reply: bool(assessment.needs_reply), finance_related: bool(assessment.finance_related) };
}

export function routeFromPayload(payload = {}, options = {}) {
  return routeEmail({ category: payload.category, labels: payload.labels, text: payload.summary || '',
    sender: payload.sender || '', subject: payload.subject || '', due_date: payload.due_date,
    required_action: payload.required_action, thread_context: payload.thread_context, ...options });
}
