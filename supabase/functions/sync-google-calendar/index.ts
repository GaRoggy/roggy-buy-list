type Json = Record<string, unknown>;

class SyncError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 500) { super(code); this.code = code; this.status = status; }
}

const DAY = 86400000;
const json = (body: Json, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

function env(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new SyncError(`MISSING_${name}`, 503);
  return value;
}

function safeError(error: unknown): SyncError {
  return error instanceof SyncError ? error : new SyncError('UNEXPECTED_ERROR');
}

const supabaseUrl = () => env('SUPABASE_URL');
const serviceKey = () => env('SUPABASE_SERVICE_ROLE_KEY');

async function supabase(path: string, options: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(30000),
      headers: {
        apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`,
        'content-type': 'application/json', ...(options.headers || {})
      }
    });
  } catch { throw new SyncError('SUPABASE_NETWORK_ERROR'); }
  if (!response.ok) throw new SyncError(`SUPABASE_HTTP_${response.status}`, response.status);
  if (response.status === 204) return null;
  try { return await response.json(); } catch { return null; }
}

async function rpc(name: string, body: Json): Promise<any> {
  return await supabase(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
}

async function googleToken(): Promise<string> {
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'),
        refresh_token: env('GOOGLE_REFRESH_TOKEN'), grant_type: 'refresh_token'
      })
    });
  } catch { throw new SyncError('GOOGLE_TOKEN_NETWORK_ERROR'); }
  if (!response.ok) throw new SyncError(response.status === 400 ? 'GOOGLE_REFRESH_TOKEN_INVALID' : `GOOGLE_TOKEN_HTTP_${response.status}`, response.status);
  let body: any;
  try { body = await response.json(); } catch { throw new SyncError('GOOGLE_TOKEN_INVALID_RESPONSE'); }
  if (typeof body.access_token !== 'string' || !body.access_token) throw new SyncError('GOOGLE_ACCESS_TOKEN_MISSING');
  return body.access_token;
}

async function google(path: string, token: string, params: Record<string, string>): Promise<any> {
  const query = new URLSearchParams(params);
  let response: Response;
  try {
    response = await fetch(`https://www.googleapis.com/${path}?${query}`, {
      signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${token}` }
    });
  } catch { throw new SyncError('GOOGLE_NETWORK_ERROR'); }
  if (!response.ok) throw new SyncError(response.status === 410 ? 'GOOGLE_SYNC_TOKEN_EXPIRED' : `GOOGLE_API_HTTP_${response.status}`, response.status);
  try { return await response.json(); } catch { throw new SyncError('GOOGLE_INVALID_RESPONSE'); }
}

function windowFor(now: Date) {
  return {
    timeMin: new Date(now.getTime() - 7 * DAY).toISOString(),
    timeMax: new Date(now.getTime() + 90 * DAY).toISOString()
  };
}

function fullSyncNeeded(cursor: Json, now: Date): boolean {
  if (typeof cursor.sync_token !== 'string' || !cursor.sync_token) return true;
  if (typeof cursor.full_sync_at !== 'string') return true;
  return now.getTime() - new Date(cursor.full_sync_at).getTime() >= DAY;
}

function normalize(event: any, calendarId: string, zone: string) {
  if (!event?.id) throw new SyncError('CALENDAR_EVENT_ID_MISSING');
  const deleted = event.status === 'cancelled';
  const start = event.start?.dateTime || event.start?.date || null;
  const end = event.end?.dateTime || event.end?.date || null;
  const valid = (value: unknown) => typeof value === 'string' && (!value.includes('T') ? /^\d{4}-\d{2}-\d{2}$/.test(value) : Number.isFinite(Date.parse(value)));
  if (!deleted && (!start || !end)) throw new SyncError('CALENDAR_EVENT_TIME_MISSING');
  if (!deleted && (!valid(start) || !valid(end))) throw new SyncError('CALENDAR_EVENT_TIME_INVALID');
  const original = event.originalStartTime && valid(event.originalStartTime.dateTime || event.originalStartTime.date) ? event.originalStartTime : null;
  const updated = valid(event.updated) ? event.updated : null;
  return {
    kind: 'calendar_event', external_id: event.id,
    status: deleted ? 'deleted' : 'processed',
    occurred_at: event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00Z` : null),
    payload: {
      title: event.summary || '(Untitled event)', start, end, all_day: !!event.start?.date,
      time_zone: event.start?.timeZone || zone, calendar_id: calendarId,
      location: typeof event.location === 'string' ? event.location.slice(0, 1000) : null,
      description: typeof event.description === 'string' ? event.description.slice(0, 4000) : null,
      updated, recurring_event_id: event.recurringEventId || null,
      original_start: original,
      recurrence: Array.isArray(event.recurrence) ? event.recurrence : null,
      url: event.htmlLink || null
    }
  };
}

async function listCalendarEvents(calendarId: string, token: string, cursor: Json, now: Date) {
  const full = fullSyncNeeded(cursor, now);
  const range = windowFor(now);
  const events: any[] = [];
  let pageToken = '';
  let nextSyncToken = '';
  let timeZone = Deno.env.get('MONITOR_TIMEZONE') || 'America/Chicago';
  for (let page = 0; page < 10000; page++) {
    const params: Record<string, string> = full
      ? { timeMin: range.timeMin, timeMax: range.timeMax, singleEvents: 'true', showDeleted: 'true', maxResults: '2500' }
      : { syncToken: String(cursor.sync_token), singleEvents: 'true', showDeleted: 'true', maxResults: '2500' };
    if (pageToken) params.pageToken = pageToken;
    const data = await google(`calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, token, params);
    if (typeof data.timeZone === 'string' && data.timeZone) timeZone = data.timeZone;
    if (Array.isArray(data.items)) events.push(...data.items);
    if (typeof data.nextSyncToken === 'string') nextSyncToken = data.nextSyncToken;
    if (!data.nextPageToken) return { events, nextSyncToken, full, range, timeZone };
    pageToken = data.nextPageToken;
  }
  throw new SyncError('GOOGLE_PAGINATION_LIMIT');
}

async function existingRecords(sourceId: string, userId: string): Promise<any[]> {
  const params = new URLSearchParams({
    select: 'id,external_id,occurred_at,status,payload', source_id: `eq.${sourceId}`,
    user_id: `eq.${userId}`, kind: 'eq.calendar_event', limit: '10000'
  });
  const rows = await supabase(`monitor_records?${params}`);
  return Array.isArray(rows) ? rows : [];
}

async function upsertRecords(userId: string, sourceId: string, records: any[]): Promise<void> {
  if (!records.length) return;
  const rows = records.map(row => ({ ...row, user_id: userId, source_id: sourceId }));
  for (let i = 0; i < rows.length; i += 250) {
    await supabase('monitor_records?on_conflict=source_id,kind,external_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 250))
    });
  }
}

function canonicalRows(userId: string, sourceId: string, source: any, records: any[]) {
  return records.map(record => {
    const p = record.payload || {};
    const deleted = record.status === 'deleted';
    return {
      user_id: userId, source_id: sourceId, source_kind: 'calendar', source_event_id: record.external_id,
      schema_version: 1, event_type: deleted ? 'calendar_event_deleted' : 'calendar_event',
      title: p.title || null,
      summary: deleted ? 'Calendar event was cancelled or removed.' : (p.location ? `Location: ${p.location}` : null),
      occurred_at: record.occurred_at, importance: 0.55, confidence: 0.98,
      action_required: false, suggested_actions: [], entities: [], domains: ['calendar'], tags: ['calendar'],
      status: deleted ? 'deleted' : 'active',
      metadata: { calendar_id: source.external_id, recurring_event_id: p.recurring_event_id || null, all_day: !!p.all_day }
    };
  });
}

async function upsertCanonical(rows: any[]): Promise<void> {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 250) {
    await supabase('monitor_events?on_conflict=user_id,source_id,source_event_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 250))
    });
  }
}

function stats(records: any[], old: any[]) {
  const oldMap = new Map(old.map(row => [row.external_id, row]));
  let inserted = 0, updated = 0, cancelled = 0;
  for (const row of records) {
    const previous = oldMap.get(row.external_id);
    if (!previous) { if (row.status === 'deleted') cancelled++; else inserted++; continue; }
    if (row.status === 'deleted' && previous.status !== 'deleted') cancelled++;
    else if (row.status !== previous.status || JSON.stringify(row.payload) !== JSON.stringify(previous.payload)) updated++;
  }
  return { inserted, updated, cancelled, processed: records.length };
}

async function syncSource(source: any, userId: string, token: string) {
  const now = new Date();
  let listing;
  try { listing = await listCalendarEvents(source.external_id, token, source.cursor || {}, now); }
  catch (error) {
    const e = safeError(error);
    if (e.code !== 'GOOGLE_SYNC_TOKEN_EXPIRED') throw e;
    listing = await listCalendarEvents(source.external_id, token, {}, now);
  }
  const old = await existingRecords(source.id, userId);
  let records = listing.events.map(event => normalize(event, source.external_id, listing.timeZone));
  if (listing.full) {
    const present = new Set(records.map(row => row.external_id));
    for (const row of old) if (row.external_id && !present.has(row.external_id)) records.push({
      kind: 'calendar_event', external_id: row.external_id, status: 'deleted', occurred_at: row.occurred_at || null,
      payload: { ...(row.payload || {}), calendar_id: source.external_id, inactive_reason: 'absent_from_full_window' }
    });
  }
  const result = stats(records, old);
  await upsertRecords(userId, source.id, records);
  let eventProjectionError: string | null = null;
  try { await upsertCanonical(canonicalRows(userId, source.id, source, records)); }
  catch (error) { eventProjectionError = safeError(error).code; }
  const cursor = {
    sync_token: listing.nextSyncToken || source.cursor?.sync_token || null,
    full_sync_at: listing.full ? now.toISOString() : (source.cursor?.full_sync_at || now.toISOString()),
    window_start: listing.full ? listing.range.timeMin : (source.cursor?.window_start || null),
    window_end: listing.full ? listing.range.timeMax : (source.cursor?.window_end || null),
    last_mode: listing.full ? 'full' : 'incremental'
  };
  const health = { ...result, full_sync: listing.full, event_projection_error: eventProjectionError };
  const completed = await rpc('monitor_cloud_complete', {
    p_source: source.id, p_user: userId, p_lease_until: source.cloud_lease_until,
    p_cursor: cursor, p_records_processed: result.processed, p_result: health
  });
  if (completed !== true) throw new SyncError('CLOUD_LEASE_LOST');
  return { calendar_id: source.external_id, ...health };
}

async function ensureSources(userId: string, ids: string[]) {
  const rows = ids.map(external_id => ({ user_id: userId, kind: 'calendar', external_id,
    enabled: true, interval_seconds: 300, config: { sync_owner: 'cloud' } }));
  const params = new URLSearchParams({ on_conflict: 'user_id,kind,external_id' });
  const result = await supabase(`monitor_sources?${params}`, {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(rows)
  });
  return Array.isArray(result) ? result : [];
}

async function main(req: Request) {
  const expected = env('SYNC_CRON_SECRET');
  const received = req.headers.get('x-sync-secret') || '';
  if (received.length !== expected.length || received !== expected) return json({ success: false, error: 'UNAUTHORIZED' }, 401);
  const userId = env('MONITOR_USER_ID');
  let ids: unknown;
  try { ids = JSON.parse(env('GOOGLE_CALENDAR_IDS')); } catch { throw new SyncError('GOOGLE_CALENDAR_IDS_INVALID', 503); }
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !id || id === 'primary')) {
    throw new SyncError('GOOGLE_CALENDAR_IDS_REQUIRED', 503);
  }
  const token = await googleToken();
  const sources = await ensureSources(userId, ids as string[]);
  const results: any[] = [];
  for (const source of sources) {
    const claimed = await rpc('monitor_cloud_claim', { p_source: source.id, p_user: userId });
    if (!claimed) continue;
    try { results.push(await syncSource(claimed, userId, token)); }
    catch (error) {
      const e = safeError(error);
      await rpc('monitor_cloud_fail', { p_source: claimed.id, p_user: userId, p_lease_until: claimed.cloud_lease_until,
        p_code: e.code, p_result: { success: false, error_code: e.code } });
      throw e;
    }
  }
  return json({ success: true, calendars: results, ai_required: false, layne_required: false, pc_required: false });
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ success: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  try { return await main(req); }
  catch (error) { const e = safeError(error); console.error(JSON.stringify({ error_code: e.code })); return json({ success: false, error: e.code }, e.status); }
});
