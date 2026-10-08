import { appendFile, mkdir } from 'node:fs/promises';
import { generatePurchaseMatches, normalizeProductName, productFingerprint, PURCHASE_MATCHING_CONFIG } from './purchase-matching.mjs';

export class MonitorError extends Error {
  constructor(code, { terminal = false, retryAfter = 0, status = 0, message = null,
    operation = null, cause = null, retryable = !terminal && (status === 0 || status === 408 || status === 429 || status >= 500),
    details = {} } = {}) {
    super(message || code);
    Object.assign(this, { code, terminal, retryAfter, status, operation, retryable,
      cause: bounded(cause, 512), details: { ...details } });
  }
  toJSON(requestId = null) {
    return {
      error_code: this.code, code: this.code, subsystem: 'purchase_monitor',
      operation: this.operation, message: this.message, cause: this.cause,
      status_code: this.status || null, target: null, retryable: this.retryable,
      timestamp: new Date().toISOString(), correlation_id: requestId, details: this.details,
    };
  }
}
function bounded(value, limit = 1024) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim()
    .replace(/(authorization|bearer|token|secret|password|cookie)\s*[:=]\s*(?:bearer\s+)?[^,\s}]+/ig, '$1=[redacted]');
  return text.length <= limit ? text : `${text.slice(0, limit - 14).trimEnd()}… [truncated]`;
}
export function failure(error) {
  if (error instanceof MonitorError) return error;
  const candidate = typeof error?.code === 'string' ? error.code
    : typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{2,96}$/.test(error.message) ? error.message : null;
  return new MonitorError(candidate || 'UNEXPECTED_ERROR', {
    cause: error?.name || 'UnknownError', operation: 'monitor.worker', retryable: true,
  });
}
export function backoff(attempt, retryAfter = 0, random = Math.random) {
  return Math.min(86400, Math.max(retryAfter, Math.min(3600, 15 * 2 ** (attempt - 1)) * (1 + random())));
}
export async function request(url, options = {}, fetcher = fetch) {
  const started = Date.now();
  let response;
  try { response = await fetcher(url, { ...options, signal: options.signal || AbortSignal.timeout(30000), redirect: 'error' }); }
  catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new MonitorError(timedOut ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR', {
      operation: 'monitor.request', cause: error?.name || 'FetchError', retryable: true,
      details: { elapsed_ms: Date.now() - started },
    });
  }
  if (!response.ok) {
    const header = response.headers.get('retry-after');
    const retryAfter = header ? (/^\d+$/.test(header) ? Number(header) : Math.max(0, (Date.parse(header) - Date.now()) / 1000)) : 0;
    const body = await response.text().catch(() => '');
    throw new MonitorError(`HTTP_${response.status}`, { status: response.status, retryAfter: retryAfter || 0,
      terminal: [400, 401, 403].includes(response.status), operation: 'monitor.request', cause: bounded(body, 512),
      details: { elapsed_ms: Date.now() - started },
      message: response.status === 401 || response.status === 403 ? 'The remote service rejected monitor authentication.'
        : `The remote service returned HTTP ${response.status}.` });
  }
  if (response.status === 204) return null;
  try {
    const body = await response.text();
    return body.trim() ? JSON.parse(body) : null;
  } catch { throw new MonitorError('INVALID_RESPONSE', { operation: 'monitor.request', cause: 'JSONParseError',
    details: { elapsed_ms: Date.now() - started } }); }
}
export function config(env = process.env) {
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'MONITOR_USER_ID']) {
    if (!env[key]) throw new MonitorError(`MISSING_${key}`, { terminal: true });
  }
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(env.SUPABASE_URL) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.MONITOR_USER_ID)) {
    throw new MonitorError('INVALID_CONFIG', { terminal: true });
  }
  const zone = env.MONITOR_TIMEZONE || 'America/Chicago';
  new Intl.DateTimeFormat('en-US', { timeZone: zone });
  return { ...env, MONITOR_TIMEZONE: zone };
}
export class Store {
  constructor(env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
  async api(path, options = {}) {
    const key = this.env.SUPABASE_SECRET_KEY;
    return request(`${this.env.SUPABASE_URL}/rest/v1/${path}`, { ...options,
      // Supabase's opaque sb_secret_* keys are accepted by the gateway only
      // when they are sent in the same two-header shape as the client SDK.
      // Legacy JWT service keys use the same shape, so keep this unconditional.
      headers: { apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json', ...options.headers } }, this.fetcher);
  }
  rpc(name, body) { return this.api(`rpc/monitor_${name}`, { method: 'POST', body: JSON.stringify(body) }); }
  async records(kind) {
    const result = [];
    for (let offset = 0; ; offset += 500) {
      const params = new URLSearchParams({ user_id: `eq.${this.env.MONITOR_USER_ID}`, kind: `eq.${kind}`,
        status: 'neq.deleted', order: 'id', limit: '500', offset: String(offset) });
      const page = await this.api(`monitor_records?${params}`);
      result.push(...page);
      if (page.length < 500) return result;
    }
  }
  async upsertEvents(source, events) {
    if (!source?.id || !Array.isArray(events) || !events.length) return 0;
    const rows = events.map(event => ({ ...event, user_id: this.env.MONITOR_USER_ID, source_id: source.id,
      source_kind: source.kind }));
    await this.api('monitor_events?on_conflict=user_id,source_id,source_event_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    return rows.length;
  }
  async enqueueUnifiedEvents(events) {
    if (!Array.isArray(events) || !events.length) return 0;
    const rows = events.map(event => ({ user_id: this.env.MONITOR_USER_ID, event }));
    await this.api('monitor_event_outbox', {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows),
    });
    return rows.length;
  }
  async ensureUnifiedEventSource(sourceKind) {
    const externalId = String(sourceKind || 'unknown').slice(0, 120);
    const params = new URLSearchParams({
      user_id: `eq.${this.env.MONITOR_USER_ID}`, kind: 'eq.unified_events',
      external_id: `eq.${externalId}`, select: 'id,kind,external_id', limit: '1',
    });
    const existing = await this.api(`monitor_sources?${params}`);
    if (Array.isArray(existing) && existing[0]?.id) return existing[0];
    const created = await this.api('monitor_sources?on_conflict=user_id,kind,external_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{
        user_id: this.env.MONITOR_USER_ID, kind: 'unified_events', external_id: externalId,
        enabled: false, interval_seconds: 3600, config: { role: 'canonical_activity_history' },
      }]),
    });
    if (Array.isArray(created) && created[0]?.id) return created[0];
    const retry = await this.api(`monitor_sources?${params}`);
    if (Array.isArray(retry) && retry[0]?.id) return retry[0];
    throw new MonitorError('UNIFIED_EVENT_SOURCE_UNAVAILABLE', { operation: 'monitor.ensure_event_source' });
  }
  async upsertUnifiedEvents(events) {
    if (!Array.isArray(events) || !events.length) return 0;
    const sourceCache = new Map();
    const rows = [];
    for (const event of events) {
      const sourceKind = String(event.source || 'unknown');
      const source = sourceCache.get(sourceKind) || await this.ensureUnifiedEventSource(sourceKind);
      sourceCache.set(sourceKind, source);
      rows.push({
        user_id: this.env.MONITOR_USER_ID,
        source_id: source.id,
        source_kind: sourceKind,
        source_event_id: String(event.event_id),
        schema_version: 2,
        event_type: event.event_type,
        category: event.category,
        severity: event.severity,
        title: event.title,
        summary: event.summary,
        occurred_at: event.timestamp,
        detected_at: event.detected_at || new Date().toISOString(),
        importance: event.importance,
        confidence: event.confidence ?? 1,
        action_required: event.action_required ?? ['warning', 'error', 'critical'].includes(event.severity),
        suggested_actions: Array.isArray(event.suggested_actions) ? event.suggested_actions.slice(0, 8) : [],
        entities: Array.isArray(event.entities) ? event.entities.slice(0, 16) : [],
        domains: Array.isArray(event.domains) ? event.domains.slice(0, 12) : [event.category],
        tags: Array.isArray(event.tags) ? event.tags.slice(0, 24) : [event.category, event.source],
        status: event.status,
        metadata: event.metadata && typeof event.metadata === 'object' ? event.metadata : {},
        room_id: event.room || null,
        device_id: event.device_id || null,
        related_entity: event.related_entity || null,
        dedupe_key: event.dedupe_key || null,
        incident_id: event.incident_id || null,
        started_at: event.started_at || null,
        resolved_at: event.resolved_at || null,
        duration_seconds: event.duration_seconds ?? null,
      });
    }
    await this.api('monitor_events?on_conflict=user_id,source_id,source_event_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
    return rows.length;
  }
  async recordEmailFeedback({ sourceMessageId, fromRoute = null, toRoute, label = {}, note = null } = {}) {
    if (!sourceMessageId || !toRoute) throw new MonitorError('EMAIL_FEEDBACK_REQUIRED');
    return this.api('rpc/record_monitor_email_feedback', { method: 'POST', body: JSON.stringify({
      p_source_message_id: String(sourceMessageId).slice(0, 200),
      p_from_route: fromRoute ? String(fromRoute).slice(0, 30) : null,
      p_to_route: String(toRoute).slice(0, 30), p_label: label && typeof label === 'object' ? label : {},
      p_note: note == null ? null : String(note).slice(0, 500),
    }) });
  }
  async emailFeedback({ limit = 200 } = {}) {
    const params = new URLSearchParams({ user_id: `eq.${this.env.MONITOR_USER_ID}`, order: 'created_at.desc', limit: String(Math.min(500, Math.max(1, Number(limit) || 200))) });
    return this.api(`monitor_email_feedback?${params}`);
  }
  async purchaseCandidates({ limit = PURCHASE_MATCHING_CONFIG.maxCandidates, receivedAt = new Date() } = {}) {
    const cutoff = new Date(new Date(receivedAt).getTime() - PURCHASE_MATCHING_CONFIG.boughtWindowDays * 86400000).toISOString();
    const params = new URLSearchParams({
      user_id: `eq.${this.env.MONITOR_USER_ID}`, list_type: 'eq.buy', status: 'eq.bought',
      select: 'id,item,category,quantity,status,bought_at,deleted_at,created_at,updated_at,target_price',
      or: `(bought_at.gte.${cutoff},updated_at.gte.${cutoff})`,
      order: 'bought_at.desc.nullslast,updated_at.desc', limit: String(Math.min(2000, Math.max(1, Number(limit) || 1000))),
    });
    const [recent, unresolved] = await Promise.all([
      this.api(`list_items?${params}`),
      this.rpc('purchase_unresolved_candidates', { p_user_id: this.env.MONITOR_USER_ID, p_cutoff: cutoff }),
    ]);
    const rows = [...(Array.isArray(recent) ? recent : []), ...(Array.isArray(unresolved) ? unresolved : [])];
    return [...new Map(rows.filter(row => row?.id).map(row => [String(row.id), row])).values()].slice(0, Math.min(2000, Math.max(1, Number(limit) || 1000)));
  }
  async purchaseHistory(purchase = {}) {
    const result = await this.rpc('purchase_related_items', {
      p_user_id: this.env.MONITOR_USER_ID,
      p_order_number: purchase.order_number || null,
      p_thread_id: purchase.thread_id || null,
      p_tracking_number: purchase.tracking_number || null,
    });
    return Array.isArray(result) ? result : [];
  }
  async processPurchaseEmail(source, record, candidates = null) {
    const payload = record?.payload || {};
    const purchase = payload.purchase;
    if (record?.status === 'deleted' || record?.status === 'needs_review' || !purchase?.purchase_related) return null;
    const availableCandidates = candidates || await this.purchaseCandidates({ receivedAt: payload.timestamp });
    const history = await this.purchaseHistory({ ...purchase, thread_id: payload.thread_id, tracking_number: purchase.tracking_number });
    const historyCandidates = history.filter(row => row?.buy_item_id && row?.item).map(row => ({
      id: row.buy_item_id, item: row.item, category: row.category, quantity: row.quantity,
      status: row.status, bought_at: row.bought_at, updated_at: row.updated_at,
    }));
    const candidateRows = [...new Map([...availableCandidates, ...historyCandidates]
      .filter(row => row?.id).map(row => [String(row.id), row])).values()];
    const decision = generatePurchaseMatches({ purchase: { ...purchase, subject: payload.subject || purchase.email_type || '' },
      candidates: candidateRows, history, receivedAt: payload.timestamp, config: PURCHASE_MATCHING_CONFIG });
    const products = (purchase.products || []).map((product, index) => ({ ...product,
      line_index: product.line_index ?? index,
      normalized_product_name: product.normalized_product_name || normalizeProductName(product.product_name),
      product_fingerprint: productFingerprint(product, index),
    }));
    const matches = decision.matches.map(match => ({ ...match, product_fingerprint: products[match.product_index]?.product_fingerprint || match.product_fingerprint }));
    const lifecycleType = ({ order_confirmation: 'order_confirmed', receipt: 'order_confirmed', shipping_confirmation: 'shipped',
      out_for_delivery: 'out_for_delivery', delivered: 'delivered', pickup_ready: 'delivered', delayed: 'delayed',
      backordered: 'backordered', cancelled: 'cancelled', refund: 'refunded', return_started: 'return_started',
      returned: 'returned', payment_confirmation: 'payment_confirmation' })[purchase.email_type] || null;
    const lifecycle = lifecycleType ? matches.map(match => ({ buy_item_id: match.buy_item_id,
      product_fingerprint: match.product_fingerprint, event_type: lifecycleType, event_at: payload.timestamp,
      details: { confidence: match.confidence, evidence: match.match_reason?.evidence || [] } })) : [];
    const result = await this.rpc('process_purchase_email', {
      p_user_id: this.env.MONITOR_USER_ID, p_source_id: source.id, p_monitor_record_id: record.id || null,
      p_email: payload, p_products: products, p_matches: matches, p_lifecycle: lifecycle,
    });
    return { ...decision, ...result, gmail_message_id: payload.source_message_id || record.external_id,
      merchant: purchase.merchant || null, email_type: purchase.email_type || null,
      products_count: products.length, auto_matches: matches.filter(match => match.match_status === 'auto').length,
      suggested_matches: matches.filter(match => match.match_status === 'suggested').length };
  }
}
// Allowlist log fields; callers cannot accidentally serialize payloads/tokens/errors.
export async function log(event, fields = {}) {
  const row = { timestamp: new Date().toISOString(), event };
  for (const key of ['job_id', 'source_id', 'attempt', 'records_processed', 'events_processed', 'error_code', 'duration_ms',
    'gmail_message_id', 'classification', 'merchant', 'products_count', 'candidate_count', 'matches_created',
    'suggestions_created', 'auto_matches', 'suggested_matches', 'rejected_candidates', 'lifecycle_events']) {
    if (fields[key] !== undefined) row[key] = fields[key];
  }
  const text = JSON.stringify(row);
  console.log(text);
  await mkdir('logs', { recursive: true });
  await appendFile(`logs/monitor-${row.timestamp.slice(0, 10)}.jsonl`, text + '\n');
}
export async function pages(get, path, params = {}) {
  const items = []; let pageToken;
  for (let page = 0; page < 10000; page++) {
    const data = await get(path, { ...params, ...(pageToken ? { pageToken } : {}) });
    items.push(...(data.items || data.messages || []));
    if (!data.nextPageToken) return { items, data };
    pageToken = data.nextPageToken;
  }
  throw new MonitorError('PAGINATION_LIMIT');
}
