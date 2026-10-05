const DAY = 86400000;

export function cloudWindow(now = new Date(), pastDays = 7, futureDays = 90) {
  const at = now instanceof Date ? now : new Date(now);
  return {
    timeMin: new Date(at.getTime() - pastDays * DAY).toISOString(),
    timeMax: new Date(at.getTime() + futureDays * DAY).toISOString()
  };
}

export function shouldFullCalendarSync(cursor = {}, now = new Date(), maxAgeMs = DAY) {
  if (!cursor.sync_token) return true;
  if (!cursor.full_sync_at) return true;
  return new Date(now).getTime() - new Date(cursor.full_sync_at).getTime() >= maxAgeMs;
}

export function normalizeCloudCalendarEvent(event, calendarId, zone = 'America/Chicago') {
  if (!event?.id) throw new Error('CALENDAR_EVENT_ID_MISSING');
  const deleted = event.status === 'cancelled';
  const start = event.start?.dateTime || event.start?.date || null;
  const end = event.end?.dateTime || event.end?.date || null;
  const valid = value => typeof value === 'string' && (!value.includes('T') ? /^\d{4}-\d{2}-\d{2}$/.test(value) : Number.isFinite(Date.parse(value)));
  if (!deleted && (!start || !end)) throw new Error('CALENDAR_EVENT_TIME_MISSING');
  if (!deleted && (!valid(start) || !valid(end))) throw new Error('CALENDAR_EVENT_TIME_INVALID');
  const original = event.originalStartTime && valid(event.originalStartTime.dateTime || event.originalStartTime.date)
    ? event.originalStartTime : null;
  const updated = valid(event.updated) ? event.updated : null;
  return {
    kind: 'calendar_event', external_id: event.id,
    status: deleted ? 'deleted' : 'processed',
    occurred_at: event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00Z` : null),
    payload: {
      title: event.summary || '(Untitled event)', start, end,
      all_day: !!event.start?.date, time_zone: event.start?.timeZone || zone,
      calendar_id: calendarId, location: typeof event.location === 'string' ? event.location.slice(0, 1000) : null,
      description: typeof event.description === 'string' ? event.description.slice(0, 4000) : null, updated,
      recurring_event_id: event.recurringEventId || null,
      original_start: original,
      recurrence: Array.isArray(event.recurrence) ? event.recurrence : null,
      url: event.htmlLink || null
    }
  };
}

export function reconcileCloudCalendarRecords(events, existing = [], calendarId, zone = 'America/Chicago') {
  const records = events.map(event => normalizeCloudCalendarEvent(event, calendarId, zone));
  const present = new Set(records.map(record => record.external_id));
  for (const old of existing) {
    if (old.external_id && !present.has(old.external_id)) records.push({
      kind: 'calendar_event', external_id: old.external_id, status: 'deleted',
      occurred_at: old.occurred_at || null,
      payload: { ...(old.payload || {}), calendar_id: calendarId, inactive_reason: 'absent_from_full_window' }
    });
  }
  return records;
}
