import { pages, MonitorError } from './core.mjs';

export function normalizeCalendar(event, calendarId, zone) {
  if (!event.id) throw new MonitorError('CALENDAR_EVENT_ID_MISSING');
  const deleted = event.status === 'cancelled';
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  if (!deleted && (!start || !end)) throw new MonitorError('CALENDAR_EVENT_TIME_MISSING');
  return { kind: 'calendar_event', external_id: event.id, status: deleted ? 'deleted' : 'processed',
    occurred_at: event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00Z` : null),
    payload: { title: event.summary || '(Untitled event)', start, end, all_day: !!event.start?.date,
      time_zone: event.start?.timeZone || zone, calendar_id: calendarId, location: event.location || null,
      description: event.description || null, attendees: (event.attendees || []).map(a => ({ email: a.email, response: a.responseStatus, self: !!a.self })),
      updated: event.updated || null, recurring_event_id: event.recurringEventId || null,
      original_start: event.originalStartTime || null, url: event.htmlLink || null } };
}
export async function syncCalendar(source, get, existing = [], now = new Date()) {
  if (source.external_id === 'primary') throw new MonitorError('CANONICAL_CALENDAR_ID_REQUIRED', { terminal: true });
  // Complete rolling-window snapshots handle recurrence expansion, moved instances,
  // cancellations and events that silently disappear. Reconcile only after all pages.
  const from = new Date(now.getTime() - 30 * 86400000).toISOString();
  const through = new Date(now.getTime() + 366 * 86400000).toISOString();
  const path = `calendar/v3/calendars/${encodeURIComponent(source.external_id)}/events`;
  const result = await pages(get, path, { timeMin: from, timeMax: through, singleEvents: 'true',
    showDeleted: 'true', maxResults: '2500' });
  const records = result.items.map(e => normalizeCalendar(e, source.external_id, result.data.timeZone));
  const present = new Set(records.map(r => r.external_id));
  for (const old of existing.filter(r => r.source_id === source.id)) {
    if (!present.has(old.external_id)) records.push({ kind: 'calendar_event', external_id: old.external_id,
      occurred_at: old.occurred_at, status: 'deleted', payload: { ...old.payload, inactive_reason: 'absent_from_complete_window' } });
  }
  return { records, cursor: { window_start: from, window_end: through, snapshot_at: now.toISOString() } };
}
