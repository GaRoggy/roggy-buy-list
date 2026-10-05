/*
 * Bounded, deterministic semantic assessment for Gmail messages.
 *
 * This module treats provider text as data. It has no action capability and
 * deliberately keeps semantic assessment separate from routing policy. An
 * optional runner may annotate an uncertain message, but its output is
 * validated and never receives tool permissions.
 */

import { MonitorError } from './core.mjs';
import { createHash } from 'node:crypto';

export const EMAIL_SEMANTIC_VERSION = 'email-semantics-v1';
export const EMAIL_SEMANTIC_MODEL_VERSION = 'none';

const MAX_TEXT = 12000;
const MAX_EVIDENCE = 12;
const DEFAULT_TIMEOUT_MS = 4500;

const CATEGORY_IMPORTANCE = {
  security: 0.96, bills: 0.86, appointments: 0.78, calendar: 0.66,
  work: 0.74, school: 0.72, travel: 0.68, personal: 0.58,
  payments: 0.60, receipts: 0.48, orders: 0.48, subscriptions: 0.46,
  shipping: 0.40, promotions: 0.08, newsletters: 0.18, unimportant: 0.12,
};

const AUTOMATED_SENDER = /(?:^|[<\s])(?:no[-_. ]?reply|do[-_. ]?not[-_. ]?reply|noreply|notifications?|alerts?|billing|receipts?|updates?|tracking|shipping|orders?|marketing|promotions?|account[-_. ]?update|support|service)[^@\s>]*@/i;
const REQUEST = /\b(?:can|could|would|will)\s+you\b|\bplease\s+(?:send|confirm|review|sign|complete|provide|call|reply|respond|let\s+me\s+know)\b|\blet\s+me\s+know\b|\bare\s+you\s+available\b|\bwhat\s+do\s+you\s+think\b|\bwhen\s+can\s+you\b|\bplease\s+confirm\b|\bplease\s+respond\b/i;
const ACTION = /\b(?:action\s+required|payment\s+failed|past\s+due|amount\s+due|payment\s+due|deadline|expires?|expiring|verify|verification|confirm(?:ation)?\s+required|signature|required\s+response|rebook|reschedule|cancel(?:lation)?\s+required|submit|approve|complete\s+(?:the\s+)?form|check[- ]?in)\b/i;
const FINANCE = /\b(?:statement|transaction|refund|payroll|direct\s+deposit|deposit|utility|insurance|credit\s+card|bank|charge|cashback|reimbursement|tax|payment\s+method|autopay|invoice|bill)\b/i;
const ACTIONABLE_FINANCE = /\b(?:payment\s+failed|card\s+declined|due|past\s+due|amount\s+due|payment\s+due|pay\s+by|deadline|verify|verification|confirm(?:ation)?\s+required|refund\s+request|fraud|unauthorized|dispute)\b/i;
const DO_NOT_REPLY = /\b(?:please\s+)?do\s*not\s+reply\b|\bno\s+reply\s+necessary\b/i;
const CODE = /\b(?:confirmation|verification|security|one[- ]?time)\s+code\b/i;
const MARKETING = /\b(?:sale|shop\s+now|discount|offer|make\s+the\s+most|save\s+\d+%|limited\s+time|deals?|upgrade|try\s+.+\s+free|hurry)\b/i;

function clip(value, limit = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function semanticCacheKey(input = {}, { classifierVersion = '3', routingPolicyVersion = 'email-routing-v3' } = {}) {
  const normalized = JSON.stringify({ classifierVersion, routingPolicyVersion,
    source_message_id: input.source_message_id || null, category: input.category || null,
    sender: clip(input.sender, 240).toLowerCase(), subject: clip(input.subject, 500),
    text: clip(input.text, MAX_TEXT), labels: safeArray(input.labels, 20).sort(), thread_context: input.thread_context || {} });
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function bool(value) { return value === true; }
function bounded(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function confidence(support, contradiction = 0, base = 0.5) {
  return Number(bounded(base + Math.min(4, support) * 0.105 - Math.min(4, contradiction) * 0.13).toFixed(3));
}

function headerMap(headers = {}) {
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(h => [String(h?.name || '').toLowerCase(), String(h?.value || '')]));
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value ?? '')]));
}

export function isAutomatedSender(headers = {}, sender = '') {
  const h = headerMap(headers);
  const auto = String(h['auto-submitted'] || '').trim().toLowerCase();
  const precedence = String(h.precedence || '').trim().toLowerCase();
  return (auto && auto !== 'no') || ['bulk', 'list', 'junk'].includes(precedence) ||
    Boolean(h['list-unsubscribe']) || AUTOMATED_SENDER.test(sender);
}

function threadState(context = {}) {
  const latest = context.latest_message_from_user ?? context.message_direction === 'outgoing';
  const replied = context.user_replied_after_request === true || context.previous_action_completed === true;
  const resolved = context.resolved === true || context.closed === true;
  return { latest, replied, resolved };
}

function fieldEvidence({ category, labels, headers, sender, subject, text, dueDate, requiredAction, threadContext }) {
  const labelSet = new Set(Array.isArray(labels) ? labels.map(String) : []);
  const combined = `${clip(subject, 1000)}\n${clip(text)}`.trim();
  const automated = isAutomatedSender(headers, sender);
  const thread = threadState(threadContext);
  const hardLow = labelSet.has('SPAM') || labelSet.has('TRASH') || labelSet.has('SENT') ||
    category === 'promotions' || category === 'newsletters';
  const softLow = category === 'unimportant' || MARKETING.test(combined);
  const explicitAction = Boolean(requiredAction || dueDate || ACTION.test(combined) || CODE.test(combined));
  const categoryAction = category === 'security' ||
    (category === 'bills' && ACTIONABLE_FINANCE.test(combined)) ||
    (category === 'payments' && ACTIONABLE_FINANCE.test(combined)) ||
    (['appointments', 'travel', 'calendar', 'work', 'school'].includes(category) && (REQUEST.test(combined) || ACTION.test(combined)));
  const directQuestion = /\b(?:can|could|would|will|are|is|do|did|when|what|why|how)\b[^\n?]{0,180}\?/i.test(combined);
  const request = REQUEST.test(combined);
  const likelyReply = !thread.latest && !automated && !DO_NOT_REPLY.test(combined) && !CODE.test(combined) &&
    !['bills', 'shipping', 'payments', 'receipts', 'orders', 'subscriptions'].includes(category) &&
    (request || directQuestion);
  const finance = ['bills', 'payments', 'receipts', 'orders', 'subscriptions'].includes(category) || FINANCE.test(combined);
  const financeAction = ACTIONABLE_FINANCE.test(combined) || category === 'bills' && Boolean(dueDate || requiredAction);
  const categoryBase = CATEGORY_IMPORTANCE[category];
  const knownCategory = Number.isFinite(categoryBase);
  const contradiction = [];
  if (hardLow && (categoryAction || likelyReply || category === 'security')) contradiction.push('bulk_or_promotional_metadata_conflicts_with_content');
  if (automated && likelyReply) contradiction.push('automated_sender_conflicts_with_reply_language');
  if (thread.replied || thread.resolved) contradiction.push('thread_appears_resolved');
  return { labelSet, combined, automated, thread, hardLow, softLow, explicitAction,
    categoryAction, directQuestion, request, likelyReply, finance, financeAction,
    categoryBase, knownCategory, contradiction };
}

export function assessEmail({ category = 'unimportant', labels = [], headers = {}, sender = '', subject = '', text = '', due_date: dueDate = null,
  required_action: requiredAction = null, thread_context: threadContext = {} } = {}) {
  const e = fieldEvidence({ category, labels, headers, sender, subject, text, dueDate, requiredAction, threadContext });
  const evidence = [];
  if (e.knownCategory) evidence.push(`category:${category}`);
  if (e.hardLow) evidence.push('provider_low_value_label');
  if (e.softLow && !e.hardLow) evidence.push('marketing_or_unimportant_language');
  if (e.explicitAction) evidence.push('explicit_action_signal');
  if (e.categoryAction) evidence.push('category_action_signal');
  if (e.likelyReply) evidence.push('human_request_or_question');
  if (e.automated) evidence.push('automated_sender');
  if (e.finance) evidence.push('financial_subject_or_category');
  if (e.financeAction) evidence.push('financial_action_signal');
  if (e.thread.replied) evidence.push('user_already_replied');
  if (e.thread.resolved) evidence.push('thread_marked_resolved');
  evidence.push(...e.contradiction.map(item => `conflict:${item}`));

  const action_required = !e.thread.resolved && !e.thread.replied && !e.thread.latest && (e.explicitAction || e.categoryAction || e.likelyReply);
  const needs_reply = !e.thread.resolved && !e.thread.replied && !e.thread.latest && e.likelyReply;
  const importance = !e.hardLow && (e.categoryBase >= 0.5 || action_required || needs_reply || category === 'security');
  const low_value = e.hardLow || (e.softLow && !action_required && !needs_reply && !importance);
  const importance_score = Number(bounded((e.categoryBase ?? 0.25) + (action_required ? 0.12 : 0) + (needs_reply ? 0.10 : 0) - (low_value ? 0.08 : 0)).toFixed(3));
  const importance_confidence = confidence(
    (e.knownCategory ? 2 : 0) + (action_required || needs_reply ? 2 : 0) + (e.finance ? 1 : 0),
    e.contradiction.length + (!e.knownCategory ? 1 : 0),
    e.knownCategory ? 0.57 : 0.48,
  );
  const action_confidence = confidence(
    (e.explicitAction ? 2 : 0) + (e.categoryAction ? 2 : 0) + (e.likelyReply ? 1 : 0),
    e.contradiction.length + (e.automated && e.likelyReply ? 2 : 0) + (e.thread.resolved ? 2 : 0),
    action_required ? 0.58 : 0.78,
  );
  const reply_confidence = confidence(
    (e.request ? 2 : 0) + (e.directQuestion ? 1 : 0) + (!e.automated ? 1 : 0),
    (e.automated ? 2 : 0) + (e.thread.replied || e.thread.resolved ? 2 : 0) + (e.category === 'shipping' ? 1 : 0),
    needs_reply ? 0.52 : 0.76,
  );
  const finance_confidence = confidence(
    (['bills', 'payments', 'receipts', 'orders', 'subscriptions'].includes(category) ? 3 : 0) + (FINANCE.test(e.combined) ? 1 : 0),
    e.hardLow && !e.financeAction ? 1 : 0,
    e.finance ? 0.55 : 0.2,
  );
  const ambiguity = [];
  if (!e.knownCategory) ambiguity.push('category_not_established');
  if (e.contradiction.length) ambiguity.push(...e.contradiction);
  if (importance_confidence < 0.72) ambiguity.push('importance_evidence_is_weak_or_mixed');
  if (action_required && action_confidence < 0.75) ambiguity.push('action_signal_is_indirect');
  if (needs_reply && reply_confidence < 0.75) ambiguity.push('reply_expectation_is_indirect');
  if (low_value && (importance || action_required)) ambiguity.push('low_value_metadata_conflicts_with_content');
  if (category === 'personal' && !action_required && !needs_reply) ambiguity.push('personal_context_requires_review');
  return {
    importance: bool(importance), importance_score, importance_confidence,
    action_required: bool(action_required), action_confidence,
    needs_reply: bool(needs_reply), reply_confidence,
    finance_related: bool(e.finance), finance_confidence,
    low_value: bool(low_value), low_value_confidence: confidence(
      (e.hardLow ? 3 : 0) + (e.softLow ? 1 : 0),
      (action_required || needs_reply || importance) ? 2 : 0,
      e.hardLow ? 0.62 : 0.38,
    ),
    ambiguity_reason: [...new Set(ambiguity)].slice(0, 8),
    evidence: [...new Set(evidence)].slice(0, MAX_EVIDENCE),
    semantic_version: EMAIL_SEMANTIC_VERSION,
    semantic_model_version: EMAIL_SEMANTIC_MODEL_VERSION,
    semantic_status: 'deterministic',
  };
}

function safeArray(value, max = 8) { return Array.isArray(value) ? value.slice(0, max).map(v => String(v).slice(0, 120)) : []; }

export function validateSemanticAssessment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MonitorError('INVALID_EMAIL_SEMANTICS');
  const boolFields = ['importance', 'action_required', 'needs_reply', 'finance_related', 'low_value'];
  for (const key of boolFields) if (typeof value[key] !== 'boolean') throw new MonitorError('INVALID_EMAIL_SEMANTICS');
  const confidenceFields = ['importance_confidence', 'action_confidence', 'reply_confidence', 'finance_confidence', 'low_value_confidence'];
  for (const key of confidenceFields) if (!Number.isFinite(Number(value[key])) || Number(value[key]) < 0 || Number(value[key]) > 1) throw new MonitorError('INVALID_EMAIL_SEMANTICS');
  return {
    ...Object.fromEntries(boolFields.map(key => [key, value[key] ?? false])),
    ...Object.fromEntries(confidenceFields.map(key => [key, Number(value[key] ?? 0)])),
    ambiguity_reason: safeArray(value.ambiguity_reason), evidence: safeArray(value.evidence, MAX_EVIDENCE),
    semantic_model_version: clip(value.semantic_model_version, 80) || 'unknown',
  };
}

function runnerInput(input) {
  const context = input.thread_context && typeof input.thread_context === 'object' ? input.thread_context : {};
  return { role: 'untrusted_email_data', email: {
    category: clip(input.category, 60), sender: clip(input.sender, 240), subject: clip(input.subject, 500),
    text: clip(input.text, MAX_TEXT), labels: safeArray(input.labels, 20), thread_context: {
      latest_message_from_user: context.latest_message_from_user === true,
      user_replied_after_request: context.user_replied_after_request === true,
      previous_action_completed: context.previous_action_completed === true,
      resolved: context.resolved === true, closed: context.closed === true,
      message_direction: clip(context.message_direction, 20),
    },
  } };
}

export function needsSecondPass(assessment) {
  return (assessment?.ambiguity_reason?.length || 0) > 0 ||
    [assessment?.importance_confidence, assessment?.action_confidence, assessment?.reply_confidence, assessment?.finance_confidence]
      .some(value => Number(value) > 0 && Number(value) < 0.72);
}

export async function semanticAssessmentWithFallback(input, runner, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const deterministic = assessEmail(input);
  if (typeof runner !== 'function' || !needsSecondPass(deterministic)) return deterministic;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new MonitorError('EMAIL_SEMANTIC_TIMEOUT')), timeoutMs); });
  try {
    const candidate = await Promise.race([Promise.resolve().then(() => runner(runnerInput(input))), timeout]);
    const model = validateSemanticAssessment(candidate);
    const conflicts = [];
    if (deterministic.low_value && (!model.low_value || model.action_required || model.needs_reply)) conflicts.push('deterministic_low_value_conflicts_with_model_action');
    if (deterministic.semantic_status === 'deterministic' && deterministic.finance_related !== model.finance_related) conflicts.push('finance_disagreement');
    if (deterministic.evidence.includes('automated_sender') && model.needs_reply) conflicts.push('automated_sender_conflicts_with_model_reply');
    const selected = conflicts.length ? deterministic : { ...deterministic, ...model };
    return {
      ...selected,
      ambiguity_reason: [...new Set([...deterministic.ambiguity_reason, ...conflicts])].slice(0, 8),
      evidence: [...new Set([...deterministic.evidence, 'optional_model_annotation', ...conflicts.map(v => `conflict:${v}`)])].slice(0, MAX_EVIDENCE),
      semantic_status: conflicts.length ? 'model_conflict' : 'model_assisted',
      semantic_model_version: model.semantic_model_version || 'unknown',
      importance_confidence: conflicts.length ? Math.min(deterministic.importance_confidence, model.importance_confidence, 0.68) : model.importance_confidence,
      action_confidence: conflicts.length ? Math.min(deterministic.action_confidence, model.action_confidence, 0.68) : model.action_confidence,
      reply_confidence: conflicts.length ? Math.min(deterministic.reply_confidence, model.reply_confidence, 0.68) : model.reply_confidence,
      finance_confidence: conflicts.length ? Math.min(deterministic.finance_confidence, model.finance_confidence, 0.68) : model.finance_confidence,
    };
  } catch {
    return { ...deterministic, semantic_status: 'model_unavailable', semantic_model_version: 'unavailable', evidence: [...deterministic.evidence, 'model_unavailable'].slice(0, MAX_EVIDENCE) };
  } finally { clearTimeout(timer); }
}
