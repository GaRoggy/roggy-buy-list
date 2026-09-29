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
  return {
    source_id: source.id,
    source_kind: source.kind,
    source_event_id: String(record.external_id),
    schema_version: 1,
    occurred_at: timestamp(record.occurred_at),
    detected_at: now.toISOString(),
    status: record.status === 'deleted' ? 'deleted' : 'active',
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
  // Promotions, newsletters, spam and routine mail stay in monitor_records but
  // do not become Layne-facing events.
  if (!payload.dashboard && !EMAIL_IMPORTANCE[category]) return null;
  const actionRequired = Boolean(payload.required_action || payload.due_date) ||
    ['security', 'bills', 'appointments', 'calendar', 'work', 'school'].includes(category);
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
  return { ...event, event_type: EMAIL_TYPES[category] || 'email', title, summary,
    importance: EMAIL_IMPORTANCE[category] ?? 0.5,
    confidence: payload.summary_method === 'provider_snippet' ? 0.9 : 0.75,
    action_required: actionRequired,
    suggested_actions: actionRequired ? [{ type: 'review_email', description: 'Review this email.' }] : [],
    entities: senderEntity(payload.sender || payload.company_person),
    domains: EMAIL_DOMAINS[category] || ['communication'],
    tags: ['gmail', category], metadata };
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
  return { ...event, event_type: 'calendar_event', title, summary, occurred_at: timestamp(payload.start, event.occurred_at),
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
    event_type: type, title, summary, importance: offline ? 0.82 : 0.50,
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

export function normalizeRecord(record, source, now = new Date()) {
  if (!record || !source?.id || !record.external_id) return null;
  if (record.kind === 'email' || source.kind === 'gmail') return normalizeEmail(record, source, now);
  if (record.kind === 'calendar_event' || source.kind === 'calendar') return normalizeCalendar(record, source, now);
  if (record.kind === 'smart_home_event' || source.kind === 'smart_home') {
    return normalizeSmartHome({ ...(record.payload && typeof record.payload === 'object' ? record.payload : {}),
      event_id: record.external_id, timestamp: record.occurred_at, deleted: record.status === 'deleted' }, source, now);
  }
  return normalizeGeneric(record, source, now);
}

export function normalizeRecords(records, source, now = new Date()) {
  if (!Array.isArray(records)) return [];
  return records.map(record => normalizeRecord(record, source, now)).filter(Boolean);
}
