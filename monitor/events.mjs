/*
 * Deterministic projection from monitor records to the compact event contract.
 * This module never sends provider text to an AI model and never copies a raw
 * provider payload into monitor_events.
 */

const MAX_TITLE = 240;
const MAX_SUMMARY = 1000;

function clip(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) || null : null;
}

function timestamp(value, fallback = null) {
  if (value == null) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function senderEntity(sender) {
  const value = clip(sender, 320);
  if (!value) return [];
  const match = value.match(/^\s*([^<]+?)\s*<([^>]+)>\s*$/);
  return [{ type: 'sender', name: clip(match?.[1] || value, 160),
    ...(match?.[2] ? { address: clip(match[2], 200) } : {}) }];
}

const EMAIL_IMPORTANCE = {
  security: 0.95, bills: 0.88, appointments: 0.78, calendar: 0.76,
  work: 0.74, school: 0.72, travel: 0.70, shipping: 0.64,
  payments: 0.60, orders: 0.52, subscriptions: 0.48, receipts: 0.42,
  personal: 0.56,
};

const EMAIL_TYPES = {
  security: 'security_alert', bills: 'bill_due', shipping: 'shipping_update',
  travel: 'travel_update', appointments: 'appointment', calendar: 'calendar_change',
  payments: 'payment_notice', receipts: 'receipt', orders: 'order_update',
  subscriptions: 'subscription_notice', work: 'work_communication', school: 'school_communication',
  personal: 'personal_communication',
};

const EMAIL_DOMAINS = {
  security: ['security'], bills: ['finance'], payments: ['finance'], receipts: ['finance'],
  subscriptions: ['finance'], orders: ['shopping'], shipping: ['shipping'],
  travel: ['travel'], appointments: ['calendar'], calendar: ['calendar'],
  work: ['work'], school: ['school'], personal: ['personal'],
};

function base(record, source, now) {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  return {
    source_id: source.id,
    source_kind: source.kind,
    source_event_id: String(record.external_id),
    schema_version: 1,
    occurred_at: timestamp(record.occurred_at),
    detected_at: now.toISOString(),
    status: record.status === 'deleted' ? 'deleted' : 'active',
    category: source.kind === 'calendar' ? 'calendar' : source.kind === 'gmail' ? 'communication' : source.kind || 'system',
    severity: 'info',
    room_id: clip(payload.room_id || payload.room, 128),
    device_id: clip(payload.device_id, 160),
    related_entity: clip(payload.related_entity, 160),
    dedupe_key: `${source.kind}:${record.external_id}`.slice(0, 160),
    incident_id: clip(payload.incident_id, 160),
    started_at: timestamp(payload.started_at),
    resolved_at: timestamp(payload.resolved_at),
    duration_seconds: Number.isFinite(Number(payload.duration_seconds)) ? Math.max(0, Number(payload.duration_seconds)) : null,
    suggested_actions: [],
    entities: [],
    domains: [],
    tags: [],
    metadata: {},
  };
}

function normalizeEmail(record, source, now) {
  const event = base(record, source, now);
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  if (record.status === 'deleted') {
    return { ...event, event_type: 'email_deleted', confidence: 1, importance: 0,
      action_required: false, tags: ['gmail', 'deleted'] };
  }
  const category = typeof payload.category === 'string' ? payload.category : 'unimportant';
  const route = typeof payload.route === 'string' ? payload.route : (payload.dashboard ? 'dashboard' : 'hidden');
  // Hidden/promotional mail remains provider data but is not presented to Layne.
  if (route === 'hidden' || !EMAIL_IMPORTANCE[category]) return null;
  const actionRequired = Boolean(payload.action_required || payload.required_action || payload.due_date);
  const title = clip(payload.subject, MAX_TITLE) || '(No subject)';
  const summary = clip(payload.summary, MAX_SUMMARY);
  const metadata = {
    category,
    classifier_version: payload.classifier_version ?? null,
    source_message_id: clip(payload.source_message_id, 200),
    thread_id: clip(payload.thread_id, 200),
    due_date: clip(payload.due_date, 40),
    monetary_amount: payload.monetary_amount && typeof payload.monetary_amount === 'object'
      ? { amount: clip(String(payload.monetary_amount.amount ?? ''), 40), currency: clip(payload.monetary_amount.currency, 8) }
      : null,
  };
  const importance = Number.isFinite(Number(payload.importance_score)) ? Number(payload.importance_score) : (EMAIL_IMPORTANCE[category] ?? 0.5);
  const confidenceFields = [payload.route_confidence, payload.importance_confidence];
  if (route === 'dashboard') confidenceFields.push(payload.action_confidence, payload.needs_reply ? payload.reply_confidence : null);
  if (route === 'finance') confidenceFields.push(payload.finance_confidence);
  if (route === 'hidden') confidenceFields.push(payload.low_value_confidence);
  const confidenceValues = confidenceFields.filter(value => value !== null && value !== undefined && value !== '')
    .map(Number).filter(Number.isFinite);
  const confidence = confidenceValues.length ? Math.max(0, Math.min(1, Math.min(...confidenceValues)))
    : (payload.summary_method === 'provider_snippet' ? 0.9 : 0.75);
  return { ...event, event_type: EMAIL_TYPES[category] || 'email', category: payload.purchase?.purchase_related ? 'purchase' : (category === 'security' ? 'security' : 'communication'),
    severity: actionRequired ? 'warning' : 'info', title, summary,
    importance,
    confidence,
    action_required: actionRequired || Boolean(payload.needs_reply),
    suggested_actions: (actionRequired || payload.needs_reply) ? [{ type: 'review_email', description: 'Review this email.' }] : [],
    entities: senderEntity(payload.sender || payload.company_person),
    domains: route === 'finance' ? ['finance'] : (EMAIL_DOMAINS[category] || ['communication']),
    tags: ['gmail', category, route], metadata: { ...metadata, route,
      needs_reply: Boolean(payload.needs_reply), importance: Boolean(payload.importance),
      importance_confidence: payload.importance_confidence ?? null,
      action_confidence: payload.action_confidence ?? null, reply_confidence: payload.reply_confidence ?? null,
      finance_confidence: payload.finance_confidence ?? null, low_value: Boolean(payload.low_value),
      low_value_confidence: payload.low_value_confidence ?? null, route_confidence: payload.route_confidence ?? null,
      ambiguity_reason: Array.isArray(payload.ambiguity_reason) ? payload.ambiguity_reason.slice(0, 8) : [],
      semantic_evidence: Array.isArray(payload.semantic_evidence) ? payload.semantic_evidence.slice(0, 12) : [],
      semantic_version: payload.semantic_version ?? null, semantic_model_version: payload.semantic_model_version ?? null,
      semantic_status: payload.semantic_status ?? null, routing_policy_version: payload.routing_policy_version ?? null } };
}

function normalizeCalendar(record, source, now) {
  const event = base(record, source, now);
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  if (record.status === 'deleted') {
    return { ...event, event_type: 'calendar_event_deleted', confidence: 1, importance: 0,
      action_required: false, tags: ['calendar', 'deleted'] };
  }
  const title = clip(payload.title, MAX_TITLE) || '(Untitled event)';
  const summary = clip(payload.description, MAX_SUMMARY);
  const actionRequired = /\b(deadline|due|interview|flight|exam|presentation|appointment)\b/i.test(title);
  const domains = /\b(flight|hotel|travel|airport|boarding)\b/i.test(title) ? ['travel'] : ['calendar'];
  return { ...event, event_type: 'calendar_event', category: 'calendar', severity: actionRequired ? 'warning' : 'info', title, summary, occurred_at: timestamp(payload.start, event.occurred_at),
    importance: actionRequired ? 0.72 : 0.55, confidence: 0.95, action_required: actionRequired,
    suggested_actions: actionRequired ? [{ type: 'review_calendar_event', description: 'Review the upcoming event.' }] : [],
    domains, tags: ['calendar'], metadata: {
      calendar_id: clip(payload.calendar_id, 200), all_day: Boolean(payload.all_day),
      location: clip(payload.location, 300), recurring_event_id: clip(payload.recurring_event_id, 200),
    } };
}

export function normalizeSmartHome(event, source = { id: 'smart-home', kind: 'smart_home' }, now = new Date()) {
  const input = event && typeof event === 'object' ? event : {};
  const type = clip(input.type, 80) || 'smart_home_event';
  const offline = /offline|unavailable|error/i.test(type) || input.online === false;
  const title = clip(input.friendly_name || input.device_name || input.device_id, MAX_TITLE) || 'Smart-home event';
  const summary = clip(input.summary || input.reason || input.new_state, MAX_SUMMARY);
  return { ...base({ external_id: input.event_id || input.id || `${type}:${input.timestamp || now.toISOString()}`,
      occurred_at: input.timestamp, status: input.deleted ? 'deleted' : 'processed' }, source, now),
    event_type: type, category: offline ? 'device' : 'smart_home', severity: offline ? 'error' : 'info', title, summary, importance: offline ? 0.82 : 0.50,
    confidence: 0.9, action_required: offline,
    suggested_actions: offline ? [{ type: 'check_device', description: 'Check the device connection.' }] : [],
    entities: input.device_id ? [{ type: 'device', name: clip(input.device_id, 160) }] : [],
    domains: ['home'], tags: ['smart_home', offline ? 'offline' : 'device'],
    metadata: { device_id: clip(input.device_id, 160), room: clip(input.room, 120) } };
}

function normalizeGeneric(record, source, now) {
  const event = base(record, source, now);
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  if (record.status === 'deleted') return { ...event, event_type: `${source.kind}_deleted`, confidence: 1, importance: 0 };
  const title = clip(payload.title || payload.name || payload.subject, MAX_TITLE);
  const summary = clip(payload.summary || payload.snippet, MAX_SUMMARY);
  if (!title && !summary) return null;
  return { ...event, event_type: source.kind || 'monitor_event', title, summary,
    importance: 0.4, confidence: 0.5, domains: [source.kind || 'monitor'], tags: [source.kind || 'monitor'] };
}

function normalizeGoogleTask(record, source, now) {
  const event = base(record, source, now), p = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const deleted = record.status === 'deleted';
  return { ...event, event_type: deleted ? 'google_task_deleted' : 'task', category: 'task', severity: !p.completed && !deleted ? 'notice' : 'info', title: clip(p.title, MAX_TITLE),
    summary: clip(p.notes, MAX_SUMMARY), occurred_at: timestamp(p.due, event.occurred_at),
    importance: p.completed ? 0.2 : 0.58, confidence: 0.98, action_required: !p.completed && !deleted,
    suggested_actions: !p.completed && !deleted ? [{ type: 'review_task', description: 'Review this task.' }] : [],
    domains: ['tasks'], tags: ['google_tasks', p.completed ? 'completed' : 'open'],
    metadata: { list_id: clip(p.list_id, 256), list_title: clip(p.list_title, 240), due: clip(p.due, 80),
      completed: Boolean(p.completed), parent: clip(p.parent, 256), untrusted_source: true } };
}

function normalizeGooglePerson(record, source, now) {
  const event = base(record, source, now), p = record.payload && typeof record.payload === 'object' ? record.payload : {};
  return { ...event, event_type: 'person_contact', title: clip(p.canonical_name, MAX_TITLE),
    summary: clip((p.emails || [])[0], MAX_SUMMARY), importance: 0.3, confidence: 0.99,
    action_required: false, domains: ['people'], tags: ['google_people', 'contact'],
    entities: [{ type: 'person', name: clip(p.canonical_name, 200), ...(p.emails?.[0] ? { address: p.emails[0] } : {}) }],
    metadata: { resource_name: clip(p.resource_name, 300), aliases: Array.isArray(p.aliases) ? p.aliases.slice(0, 8) : [],
      organization: clip(p.organization, 240), job_title: clip(p.job_title, 200), untrusted_source: true } };
}

function normalizeDriveFile(record, source, now) {
  const event = base(record, source, now), p = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const deleted = record.status === 'deleted';
  return { ...event, event_type: deleted ? 'drive_file_deleted' : 'drive_file', title: clip(p.name, MAX_TITLE),
    summary: clip(p.mime_type, MAX_SUMMARY), importance: 0.25, confidence: 0.99, action_required: false,
    domains: ['documents'], tags: ['google_drive', p.mime_type || 'file'],
    metadata: { file_id: clip(p.file_id, 256), mime_type: clip(p.mime_type, 200), modified_time: clip(p.modified_time, 80),
      web_view_link: clip(p.web_view_link, 1000), parent_ids: Array.isArray(p.parent_ids) ? p.parent_ids.slice(0, 20) : [], untrusted_source: true } };
}

export function normalizeRecord(record, source, now = new Date()) {
  if (!record || !source?.id || !record.external_id) return null;
  if (record.kind === 'email' || source.kind === 'gmail') return normalizeEmail(record, source, now);
  if (record.kind === 'calendar_event' || source.kind === 'calendar') return normalizeCalendar(record, source, now);
  if (record.kind === 'smart_home_event' || source.kind === 'smart_home') {
    return normalizeSmartHome({ ...(record.payload && typeof record.payload === 'object' ? record.payload : {}),
      event_id: record.external_id, timestamp: record.occurred_at, deleted: record.status === 'deleted' }, source, now);
  }
  if (record.kind === 'google_task' || source.kind === 'google_tasks') return normalizeGoogleTask(record, source, now);
  if (record.kind === 'google_person' || source.kind === 'google_people') return normalizeGooglePerson(record, source, now);
  if (record.kind === 'google_drive_file' || source.kind === 'google_drive') return normalizeDriveFile(record, source, now);
  return normalizeGeneric(record, source, now);
}

export function normalizeRecords(records, source, now = new Date()) {
  if (!Array.isArray(records)) return [];
  return records.map(record => normalizeRecord(record, source, now)).filter(Boolean);
}
