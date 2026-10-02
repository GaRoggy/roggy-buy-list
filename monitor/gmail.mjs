import { pages, MonitorError } from './core.mjs';
import { routeEmail, routeAssessment } from './email-routing.mjs';
import { semanticAssessmentWithFallback, semanticCacheKey } from './email-semantics.mjs';
import { extractPurchaseData } from './purchase-matching.mjs';

function plainText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 65536);
  return (part.parts || []).map(plainText).join('\n').slice(0, 65536);
}
export function classifyEmail(message) {
  const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  const subject = headers.subject || '', labels = new Set(message.labelIds || []);
  const body = plainText(message.payload) || message.snippet || '';
  const text = `${subject}\n${body}`;
  const rules = [
    ['security', /(?:unrecognized|unusual|suspicious) (?:sign.?in|login|activity)|security (?:alert|notice)|password (?:changed|reset)/i],
    ['school', /\b(exam|professor|syllabus|assignment|tuition|class cancelled)\b/i],
    ['bills', /\b(bill|invoice|payment due|past due|amount due)\b/i],
    ['shipping', /\b(tracking|shipped|shipment|out for delivery|package arriving|delivered)\b/i],
    ['travel', /\b(itinerary|boarding|flight|hotel reservation|booking confirmation)\b/i],
    ['appointments', /\b(appointment|reservation reminder)\b/i],
    ['calendar', /\b(invitation|rescheduled|calendar|meeting cancelled)\b/i],
    ['payments', /\b(payment received|payment confirmation|payment processed)\b/i],
    ['receipts', /\b(receipt|purchase confirmation)\b/i],
    ['orders', /\b(order confirmation|order number|order placed)\b/i],
    ['subscriptions', /\b(subscription|renewal|membership)\b/i],
    ['work', /\b(interview|recruiter|project deadline|work meeting)\b/i],
  ];
  let category = rules.find(([, regex]) => regex.test(text))?.[0] || (labels.has('IMPORTANT') ? 'personal' : 'unimportant');
  const promotional = labels.has('CATEGORY_PROMOTIONS') || /\b(\d+% off|sale ends|shop now|limited.time offer|promo code)\b/i.test(subject);
  const newsletter = /\b(newsletter|weekly digest|daily digest)\b/i.test(subject) || (!!headers['list-unsubscribe'] && !rules.some(([,r]) => r.test(subject)));
  if (labels.has('SPAM') || labels.has('TRASH') || labels.has('SENT')) category = 'unimportant';
  else if (promotional) category = 'promotions';
  else if (newsletter) category = 'newsletters';
  const reasons = {
    security: 'The message reports an account security change or suspicious sign-in.',
    bills: 'The message mentions a bill, invoice or payment due.',
    shipping: 'The message contains a package delivery or shipping update.',
    appointments: 'The message concerns an appointment.',
    calendar: 'The message reports scheduling information.',
    travel: 'The message contains travel or reservation information.',
    personal: 'Gmail marked this message important.',
  };
  if (['school', 'work'].includes(category) && /\b(moved|changed|cancelled|deadline|due|interview)\b/i.test(text)) reasons[category] = 'The message mentions an actionable school or work schedule change.';
  const due = text.match(/\b(?:due|pay by|deadline)\s*(?:on|:)?\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1] || null;
  const amount = text.match(/\b(USD|EUR|GBP)\s*(\d+(?:,\d{3})*(?:\.\d{2})?)\b/);
  const order = text.match(/\border (?:number|id|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,40})\b/i)?.[1] || null;
  const tracking = text.match(/\btracking (?:number|id|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{7,40})\b/i)?.[1] || null;
  const routing = routeEmail({ category, labels: [...labels], text: body, headers, sender: headers.from || '',
    subject, due_date: due, required_action: due ? 'Review the stated deadline.' : null });
  const purchase = extractPurchaseData({ subject, body, sender: headers.from || '',
    timestamp: new Date(Number(message.internalDate)).toISOString(), category,
    monetary_amount: amount ? { amount: amount[2].replaceAll(',', ''), currency: amount[1] } : null });
  return { sender: headers.from || null, subject, timestamp: new Date(Number(message.internalDate)).toISOString(),
    category, summary: (message.snippet || '').slice(0, 500), summary_method: 'provider_snippet',
    required_action: due ? 'Review the stated deadline.' : null, due_date: due,
    monetary_amount: amount ? { amount: amount[2].replaceAll(',', ''), currency: amount[1] } : null,
    company_person: headers.from || null, order_information: order, tracking_information: tracking,
    event_information: null, urgency: category === 'security' ? 'IMPORTANT' : 'NOTICE',
    dashboard: routing.route === 'dashboard', route: routing.route, reason: routing.reason || reasons[category] || null,
    action_required: routing.action_required, needs_reply: routing.needs_reply,
    finance_related: routing.finance_related, importance: routing.importance, importance_score: routing.importance_score,
    importance_confidence: routing.importance_confidence, action_confidence: routing.action_confidence,
    reply_confidence: routing.reply_confidence, finance_confidence: routing.finance_confidence,
    low_value: routing.low_value, low_value_confidence: routing.low_value_confidence,
    route_confidence: routing.route_confidence, ambiguity_reason: routing.ambiguity_reason,
    semantic_evidence: routing.evidence, semantic_version: routing.semantic_version,
    semantic_model_version: routing.semantic_model_version, semantic_status: routing.semantic_status,
    routing_version: routing.routing_version, routing_policy_version: routing.routing_policy_version,
    semantic_cache_key: semanticCacheKey({ source_message_id: message.id, category, labels: [...labels], headers,
      sender: headers.from || '', subject, text: body }),
    labels: [...labels], source_message_id: message.id, thread_id: message.threadId, classifier_version: 3,
    purchase_related: purchase.purchase_related, purchase,
    extraction_notes: 'Deterministic, conservative extraction. Ambiguous amounts, relative dates and event details remain unknown.' };
}

function semanticInput(message, threadContext = {}) {
  const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  const subject = headers.subject || '';
  const body = plainText(message.payload) || message.snippet || '';
  return { category: classifyEmail(message).category, labels: message.labelIds || [], headers,
    sender: headers.from || '', subject, text: body, thread_context: threadContext };
}

export async function classifyEmailWithSemanticRunner(message, { runner, threadContext = {}, timeoutMs } = {}) {
  const base = classifyEmail(message);
  const assessment = await semanticAssessmentWithFallback(semanticInput(message, threadContext), runner, { timeoutMs });
  const routing = routeAssessment({ ...assessment, importance_score: base.importance_score }, { due_date: base.due_date });
  return { ...base, importance: assessment.importance, action_required: assessment.action_required,
    needs_reply: assessment.needs_reply, finance_related: assessment.finance_related,
    importance_confidence: assessment.importance_confidence, action_confidence: assessment.action_confidence,
    reply_confidence: assessment.reply_confidence, finance_confidence: assessment.finance_confidence,
    low_value: assessment.low_value, low_value_confidence: assessment.low_value_confidence,
    route_confidence: routing.route_confidence, route: routing.route, dashboard: routing.route === 'dashboard',
    reason: routing.reason || base.reason, ambiguity_reason: routing.ambiguity_reason,
    semantic_evidence: assessment.evidence, semantic_version: assessment.semantic_version,
    semantic_model_version: assessment.semantic_model_version, semantic_status: assessment.semantic_status,
    routing_version: routing.routing_version, routing_policy_version: routing.routing_policy_version,
    semantic_cache_key: semanticCacheKey({ ...semanticInput(message, threadContext), source_message_id: message.id }) };
}

export async function syncGmail(source, get, existing = [], { semanticRunner = null, threadContextById = () => ({}) } = {}) {
  const base = 'gmail/v1/users/me/';
  let historyId = source.cursor?.historyId, ids = new Set(), finalId;
  if (historyId) {
    try {
      let token;
      do {
        const data = await get(base + 'history', { startHistoryId: historyId, maxResults: '500', ...(token ? {pageToken:token} : {}) });
        for (const history of data.history || []) for (const message of history.messages || []) ids.add(message.id);
        token = data.nextPageToken; finalId = data.historyId;
      } while (token);
    } catch (e) {
      if (e.status === 403) {
        // Gmail may briefly reject history reads while applying quota or
        // mailbox policy. Let the worker retry instead of disabling Gmail.
        e.terminal = false;
        e.retryAfter = Math.max(e.retryAfter || 0, 60);
        throw e;
      }
      if (e.status !== 404) throw e;
      historyId = null; ids = new Set();
    }
    // Retry only messages that were temporarily unreadable on the next
    // incremental run; this does not rescan the mailbox.
    for (const row of existing.filter(r => r.source_id === source.id && r.status === 'needs_review')) ids.add(row.external_id);
  }
  if (!historyId) {
    // Capture BEFORE listing; changes during bootstrap are replayed next time.
    finalId = (await get(base + 'profile')).historyId;
    const recent = await pages(get, base + 'messages', { q: 'newer_than:90d', includeSpamTrash: 'true', maxResults: '500' });
    for (const message of recent.items) ids.add(message.id);
    for (const row of existing.filter(r => r.source_id === source.id)) ids.add(row.external_id);
  }
  if (!finalId) throw new MonitorError('GMAIL_CURSOR_MISSING');
  const records = [];
  for (const id of ids) {
    try {
      const message = await get(base + `messages/${encodeURIComponent(id)}`, { format: 'full' });
      const payload = semanticRunner
        ? await classifyEmailWithSemanticRunner(message, { runner: semanticRunner, threadContext: threadContextById(id) })
        : classifyEmail(message);
      records.push({ kind: 'email', external_id: id, occurred_at: payload.timestamp, payload });
    } catch (e) {
      if (e.status === 404) records.push({ kind: 'email', external_id: id, status: 'deleted', occurred_at: null, payload: {} });
      else if (e.status === 403) records.push({ kind: 'email', external_id: id, status: 'needs_review', occurred_at: null,
        payload: { category: 'unavailable', dashboard: false,
          extraction_notes: 'Gmail denied access to this message; it was skipped without storing message content.' } });
      else throw e;
    }
  }
  return { records, cursor: { historyId: finalId } };
}
