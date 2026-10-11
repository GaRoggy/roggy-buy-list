import { normalizeGarminCsv, validateImportedRecords } from '../_shared/garmin-normalize.js';

const SITE_ORIGIN = 'https://garoggy.github.io';
const SOURCE_EXTERNAL_ID = 'official-export-import';
const DELETE_PHRASE = 'DELETE ALL GARMIN DATA';
const MAX_REQUEST_BYTES = 14 * 1024 * 1024;
type Json = Record<string, unknown>;

class ControlError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

function env(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ControlError(`MISSING_${name}`, 503);
  return value;
}
function keyFromGroup(groupName: string, fallbackName: string): string {
  const grouped = Deno.env.get(groupName)?.trim();
  if (grouped) {
    try {
      const parsed = JSON.parse(grouped);
      if (typeof parsed.default === 'string' && parsed.default) return parsed.default;
    } catch { throw new ControlError(`INVALID_${groupName}`, 503); }
  }
  return env(fallbackName);
}
function supabaseUrl(): string { return env('SUPABASE_URL').replace(/\/$/, ''); }
function publicKey(): string { return keyFromGroup('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'); }
function databaseHeaders(): Record<string, string> {
  const grouped = Deno.env.get('SUPABASE_SECRET_KEYS')?.trim();
  if (grouped) {
    try {
      const parsed = JSON.parse(grouped);
      if (typeof parsed.default === 'string' && parsed.default) return { apikey: parsed.default, 'content-type': 'application/json' };
    } catch { throw new ControlError('INVALID_SUPABASE_SECRET_KEYS', 503); }
  }
  const secret = env('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
}
function cors(origin: string) {
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
    'access-control-max-age': '86400', 'cache-control': 'no-store', vary: 'origin' };
}
function json(body: Json, status: number, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8' } });
}
function url(path: string): string { return `${supabaseUrl()}/rest/v1/${path}`; }
async function authenticatedUser(req: Request): Promise<string> {
  const bearer = req.headers.get('authorization') || '';
  const token = bearer.replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length > 4096) throw new ControlError('AUTHENTICATION_REQUIRED', 401);
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl()}/auth/v1/user`, { signal: AbortSignal.timeout(10000),
      headers: { apikey: publicKey(), authorization: `Bearer ${token}` } });
  } catch { throw new ControlError('AUTHENTICATION_UNAVAILABLE', 503); }
  if (!response.ok) throw new ControlError('AUTHENTICATION_REQUIRED', 401);
  const user = await response.json().catch(() => null);
  if (!user || typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id)) throw new ControlError('AUTHENTICATION_REQUIRED', 401);
  return user.id;
}
async function db(path: string, options: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url(path), { ...options, signal: options.signal || AbortSignal.timeout(15000),
      headers: { ...databaseHeaders(), ...(options.headers || {}) } });
  } catch { throw new ControlError('DATABASE_UNAVAILABLE', 503); }
  if (!response.ok) throw new ControlError(`DATABASE_HTTP_${response.status}`, response.status === 429 || response.status >= 500 ? 503 : 400);
  const text = await response.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { throw new ControlError('DATABASE_INVALID_RESPONSE', 503); }
}
async function readBody(req: Request): Promise<Json> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ControlError('UNSUPPORTED_CONTENT_TYPE', 415);
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) throw new ControlError('REQUEST_TOO_LARGE', 413);
  const reader = req.body?.getReader();
  if (!reader) throw new ControlError('INVALID_JSON', 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ControlError('REQUEST_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
  } finally { try { reader.releaseLock(); } catch {} }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ControlError('INVALID_JSON', 400); }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Json;
  } catch { throw new ControlError('INVALID_JSON', 400); }
}
function userFilter(userId: string): URLSearchParams { return new URLSearchParams({ user_id: `eq.${userId}` }); }
function idFilter(ids: string[]): string {
  const clean = ids.filter(id => /^[0-9a-f-]{36}$/i.test(id));
  return clean.length ? `in.(${clean.join(',')})` : 'in.(00000000-0000-0000-0000-000000000000)';
}
async function getImportSource(userId: string, create: boolean): Promise<{ id: string; enabled: boolean } | null> {
  const query = new URLSearchParams({ user_id: `eq.${userId}`, kind: 'eq.garmin', external_id: `eq.${SOURCE_EXTERNAL_ID}`,
    select: 'id,enabled', limit: '1' });
  const rows = await db(`monitor_sources?${query}`);
  if (Array.isArray(rows) && rows[0]?.id) return { id: String(rows[0].id), enabled: Boolean(rows[0].enabled) };
  if (!create) return null;
  const created = await db('monitor_sources?on_conflict=user_id,kind,external_id', { method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([{ user_id: userId,
      kind: 'garmin', external_id: SOURCE_EXTERNAL_ID, enabled: false, interval_seconds: 3600,
      config: { method: 'official_export_import', credentials_stored: false } }]) });
  if (Array.isArray(created) && created[0]?.id) return { id: String(created[0].id), enabled: false };
  const retry = await db(`monitor_sources?${query}`);
  if (Array.isArray(retry) && retry[0]?.id) return { id: String(retry[0].id), enabled: Boolean(retry[0].enabled) };
  throw new ControlError('GARMIN_SOURCE_UNAVAILABLE', 503);
}
async function writeRecords(userId: string, sourceId: string, records: ReturnType<typeof validateImportedRecords>) {
  let writeAttempted = false;
  try {
    for (let i = 0; i < records.length; i += 300) {
      const batch = records.slice(i, i + 300).map(record => ({ user_id: userId, source_id: sourceId, kind: record.kind,
        external_id: record.external_id, occurred_at: record.occurred_at, status: 'processed', payload: record.payload }));
      writeAttempted = true;
      await db('monitor_records?on_conflict=source_id,kind,external_id', { method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(batch) });
    }
    const query = new URLSearchParams({ user_id: `eq.${userId}`, id: `eq.${sourceId}` });
    const now = new Date().toISOString();
    writeAttempted = true;
    await db(`monitor_sources?${query}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ enabled: false, last_attempt_at: now, last_success_at: now, records_processed: records.length,
        error_code: null, next_run_at: new Date(Date.now() + 3600000).toISOString() }) });
  } catch (error) {
    if (writeAttempted) throw new ControlError('GARMIN_IMPORT_RETRY_SAFE', 503);
    throw error;
  }
}
async function importCsv(userId: string, body: Json) {
  if (typeof body.csv !== 'string' || body.csv.length > 6 * 1024 * 1024) throw new ControlError('GARMIN_CSV_TOO_LARGE', 413);
  const sourceTimezone = typeof body.source_timezone === 'string' ? body.source_timezone.slice(0, 80) : 'UTC';
  let normalized;
  try { normalized = await normalizeGarminCsv(body.csv, { sourceTimezone }); }
  catch (error) { throw new ControlError(error instanceof Error ? error.message.slice(0, 64) : 'GARMIN_CSV_INVALID', 400); }
  let records: ReturnType<typeof validateImportedRecords>;
  try { records = validateImportedRecords(normalized.records); }
  catch { throw new ControlError('GARMIN_CSV_INVALID', 422); }
  if (!records.length) throw new ControlError('GARMIN_CSV_NO_SUPPORTED_RECORDS', 422);
  const source = await getImportSource(userId, true);
  if (!source) throw new ControlError('GARMIN_SOURCE_UNAVAILABLE', 503);
  await writeRecords(userId, source.id, records);
  const metrics = [...new Set(records.filter(row => row.kind === 'health_measurement').map(row => row.payload.metric))].sort();
  return { imported: records.length, metrics, activities: records.filter(row => row.kind === 'garmin_activity').length,
    warnings: normalized.warnings.length };
}
async function syncNow(userId: string) {
  const query = new URLSearchParams({ user_id: `eq.${userId}`, kind: 'eq.garmin', external_id: 'eq.approved-api',
    enabled: 'eq.true', select: 'id,external_id,config', limit: '1' });
  const sources = await db(`monitor_sources?${query}`);
  const source = Array.isArray(sources) ? sources.find(row => row.config?.api_sync_enabled === true) : null;
  if (!source?.id) throw new ControlError('GARMIN_APPROVED_API_ACCESS_REQUIRED', 409);
  if (Deno.env.get('GARMIN_API_SYNC_ENABLED')?.trim() !== 'true') throw new ControlError('GARMIN_API_SYNC_NOT_IMPLEMENTED', 409);
  const jobsQuery = new URLSearchParams({ user_id: `eq.${userId}`, source_id: `eq.${source.id}`,
    status: 'in.(queued,running)', select: 'id,status', limit: '1' });
  const active = await db(`monitor_jobs?${jobsQuery}`);
  if (Array.isArray(active) && active[0]) return { status: 'already_queued' };
  try {
    await db('monitor_jobs', { method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ user_id: userId, source_id: source.id, type: 'manual_garmin_sync',
        status: 'queued', priority: 100, run_at: new Date().toISOString() }]) });
  } catch (error) {
    if (error instanceof ControlError && error.code === 'DATABASE_HTTP_409') return { status: 'already_queued' };
    throw error;
  }
  return { status: 'queued' };
}
async function deleteAll(userId: string, body: Json) {
  if (body.confirmation !== DELETE_PHRASE) throw new ControlError('GARMIN_DELETE_CONFIRMATION_REQUIRED', 400);
  const sourcesQuery = new URLSearchParams({ user_id: `eq.${userId}`, kind: 'eq.garmin', select: 'id' });
  const sources = await db(`monitor_sources?${sourcesQuery}`);
  const sourceIds = Array.isArray(sources) ? sources.map(row => String(row.id)).filter(id => /^[0-9a-f-]{36}$/i.test(id)) : [];
  const eventQuery = new URLSearchParams({ user_id: `eq.${userId}`, source_kind: 'eq.garmin' });
  await db(`monitor_events?${eventQuery}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (sourceIds.length) {
    const sourceFilter = idFilter(sourceIds);
    const recordsQuery = new URLSearchParams({ user_id: `eq.${userId}`, source_id: sourceFilter });
    await db(`monitor_records?${recordsQuery}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    const jobsQuery = new URLSearchParams({ user_id: `eq.${userId}`, source_id: sourceFilter, select: 'id' });
    const jobs = await db(`monitor_jobs?${jobsQuery}`);
    const jobIds = Array.isArray(jobs) ? jobs.map(row => String(row.id)).filter(id => /^[0-9a-f-]{36}$/i.test(id)) : [];
    if (jobIds.length) {
      const runQuery = new URLSearchParams({ user_id: `eq.${userId}`, job_id: idFilter(jobIds) });
      await db(`monitor_runs?${runQuery}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      const deleteJobs = new URLSearchParams({ user_id: `eq.${userId}`, id: idFilter(jobIds) });
      await db(`monitor_jobs?${deleteJobs}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
    const deleteSources = new URLSearchParams({ user_id: `eq.${userId}`, id: sourceFilter });
    await db(`monitor_sources?${deleteSources}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
  return { deleted: true, local_tokens_revoked: false };
}

Deno.serve(async req => {
  let origin = SITE_ORIGIN;
  try {
    origin = req.headers.get('origin') || '';
    if (origin !== SITE_ORIGIN) throw new ControlError('ORIGIN_NOT_ALLOWED', 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (req.method !== 'POST') throw new ControlError('METHOD_NOT_ALLOWED', 405);
    const userId = await authenticatedUser(req);
    const body = await readBody(req);
    const action = body.action;
    if (action === 'import-csv') return json({ ok: true, ...(await importCsv(userId, body)) }, 200, origin);
    if (action === 'sync-now') return json({ ok: true, ...(await syncNow(userId)) }, 200, origin);
    if (action === 'delete-all') return json({ ok: true, ...(await deleteAll(userId, body)) }, 200, origin);
    throw new ControlError('GARMIN_ACTION_UNSUPPORTED', 400);
  } catch (error) {
    const code = error instanceof ControlError ? error.code : 'GARMIN_CONTROL_FAILED';
    const status = error instanceof ControlError ? error.status : 503;
    return json({ ok: false, error_code: code }, status, origin === SITE_ORIGIN ? origin : SITE_ORIGIN);
  }
});
