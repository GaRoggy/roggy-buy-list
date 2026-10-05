import { readFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { MonitorError } from './core.mjs';

const OUTBOX = process.env.LAYNE_EVENT_OUTBOX || fileURLToPath(new URL('../logs/event-outbox/', import.meta.url));
const SEVERITIES = new Set(['info', 'notice', 'warning', 'error', 'critical']);
const STATUSES = new Set(['active', 'resolved', 'deleted']);
const SENSITIVE = /(token|secret|password|authorization|cookie|credential|api[_-]?key|snapshot|raw[_-]?body|transcript|message|text)/i;

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function safeObject(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return depth > 3 ? null : value;
  if (['string', 'number', 'boolean'].includes(typeof value)) return typeof value === 'string' ? clip(value, 500) : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeObject(item, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, 40)
    .filter(([key]) => !SENSITIVE.test(key))
    .map(([key, item]) => [clip(key, 80), safeObject(item, depth + 1)]));
}

function iso(value, fallback = new Date().toISOString()) {
  const date = value ? new Date(value) : new Date(fallback);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function stableId(input) {
  if (input.event_id && /^[A-Za-z0-9_.:-]{1,160}$/.test(String(input.event_id))) return String(input.event_id);
  const bucket = Math.floor(new Date(input.timestamp || Date.now()).getTime() / 300000);
  return `evt_${createHash('sha256').update(JSON.stringify([input.source, input.event_type, input.dedupe_key, bucket])).digest('hex').slice(0, 32)}`;
}

export function normalizeUnifiedEvent(input, now = new Date()) {
  if (!input || typeof input !== 'object') throw new MonitorError('UNIFIED_EVENT_INVALID');
  const eventType = clip(input.event_type || input.type, 128);
  const category = clip(input.category, 64);
  const source = clip(input.source, 128);
  if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(eventType || '') || !/^[a-z][a-z0-9_.-]{1,63}$/.test(category || '') || !source) {
    throw new MonitorError('UNIFIED_EVENT_SCHEMA_INVALID');
  }
  const severity = String(input.severity || 'info').toLowerCase();
  const status = String(input.status || 'active').toLowerCase();
  if (!SEVERITIES.has(severity) || !STATUSES.has(status)) throw new MonitorError('UNIFIED_EVENT_ENUM_INVALID');
  const importance = Number(input.importance);
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) throw new MonitorError('UNIFIED_EVENT_IMPORTANCE_INVALID');
  if (importance < 0.15 || input.noise === true || input.metadata?.noise === true) return null;
  const timestamp = iso(input.timestamp, now.toISOString());
  const id = stableId(input);
  return {
    event_id: id,
    timestamp,
    detected_at: iso(input.detected_at, now.toISOString()),
    event_type: eventType,
    category,
    severity,
    source,
    title: clip(input.title, 240) || 'Layne activity',
    summary: clip(input.summary, 1000),
    room: clip(input.room, 128),
    device_id: clip(input.device_id, 160),
    related_entity: clip(input.related_entity, 160),
    metadata: safeObject(input.metadata || {}),
    importance: Math.round(importance * 1000) / 1000,
    confidence: Math.max(0, Math.min(1, Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 1)),
    action_required: input.action_required === undefined ? ['warning', 'error', 'critical'].includes(severity) : Boolean(input.action_required),
    suggested_actions: Array.isArray(input.suggested_actions) ? input.suggested_actions.slice(0, 8).map(item => safeObject(item)) : [],
    entities: Array.isArray(input.entities) ? input.entities.slice(0, 16).map(item => safeObject(item)) : [],
    domains: Array.isArray(input.domains) ? input.domains.slice(0, 12).map(item => clip(item, 64)).filter(Boolean) : [category],
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 24).map(item => clip(item, 64)).filter(Boolean) : [category, source],
    status,
    dedupe_key: clip(input.dedupe_key, 160),
    incident_id: clip(input.incident_id, 160),
    started_at: input.started_at ? iso(input.started_at, timestamp) : null,
    resolved_at: input.resolved_at ? iso(input.resolved_at, timestamp) : null,
    duration_seconds: input.duration_seconds == null ? null : Math.max(0, Number(input.duration_seconds) || 0),
  };
}

export async function flushUnifiedEventOutbox(store, { directory = OUTBOX, limit = 100 } = {}) {
  let names;
  try { names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort().slice(0, Math.max(1, Math.min(500, limit))); }
  catch (error) {
    if (error?.code === 'ENOENT') names = [];
    else throw new MonitorError('UNIFIED_EVENT_OUTBOX_UNAVAILABLE', { cause: error?.name || 'ReadError' });
  }
  const events = [];
  const files = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await readFile(join(directory, name), 'utf8'));
      const event = normalizeUnifiedEvent(raw);
      if (event) { events.push(event); files.push(name); }
      else await unlink(join(directory, name));
    } catch { /* retain malformed files for bounded manual diagnosis */ }
  }
  const localResult = { queued: names.length, flushed: 0, failed: 0 };
  if (!events.length) {
    const remote = await flushSupabaseUnifiedEventOutbox(store, { limit });
    return { ...localResult, ...remote, queued: names.length + remote.queued };
  }
  try {
    const flushed = typeof store.enqueueUnifiedEvents === 'function'
      ? await store.enqueueUnifiedEvents(events)
      : await store.upsertUnifiedEvents(events);
    await Promise.all(files.map(name => unlink(join(directory, name)).catch(() => {})));
    if (typeof store.enqueueUnifiedEvents !== 'function') localResult.flushed = flushed;
  } catch (error) {
    localResult.failed = events.length;
    localResult.error_code = error?.code || 'UNIFIED_EVENT_UPSERT_FAILED';
  }
  const remote = await flushSupabaseUnifiedEventOutbox(store, { limit });
  return {
    queued: localResult.queued + remote.queued,
    flushed: localResult.flushed + remote.flushed,
    failed: localResult.failed + remote.failed,
    error_code: localResult.error_code || remote.error_code,
  };
}

export async function flushSupabaseUnifiedEventOutbox(store, { limit = 100 } = {}) {
  let rows;
  try {
    const params = new URLSearchParams({
      user_id: `eq.${store.env.MONITOR_USER_ID}`,
      select: 'id,event', order: 'created_at.asc', limit: String(Math.max(1, Math.min(500, limit))),
    });
    rows = await store.api(`monitor_event_outbox?${params}`);
  } catch (error) {
    return { queued: 0, flushed: 0, failed: 0, error_code: error?.code || 'UNIFIED_EVENT_OUTBOX_READ_FAILED' };
  }
  if (!Array.isArray(rows) || !rows.length) return { queued: 0, flushed: 0, failed: 0 };
  const events = [];
  const removable = [];
  for (const row of rows) {
    try {
      const event = normalizeUnifiedEvent(row?.event);
      removable.push(row.id);
      if (event) events.push(event);
    } catch {
      removable.push(row.id);
    }
  }
  if (events.length) {
    try {
      await store.upsertUnifiedEvents(events);
    } catch (error) {
      return { queued: rows.length, flushed: 0, failed: events.length, error_code: error?.code || 'UNIFIED_EVENT_UPSERT_FAILED' };
    }
  }
  try {
    const ids = removable.filter(id => /^[0-9a-f-]{36}$/i.test(String(id)));
    if (ids.length) {
      const query = new URLSearchParams({ id: `in.(${ids.join(',')})`, user_id: `eq.${store.env.MONITOR_USER_ID}` });
      await store.api(`monitor_event_outbox?${query}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  } catch (error) {
    return { queued: rows.length, flushed: events.length, failed: removable.length, error_code: error?.code || 'UNIFIED_EVENT_OUTBOX_DELETE_FAILED' };
  }
  return { queued: rows.length, flushed: events.length, failed: 0 };
}
