import { appendFile, mkdir } from 'node:fs/promises';

export class MonitorError extends Error {
  constructor(code, { terminal = false, retryAfter = 0, status = 0 } = {}) {
    super(code); Object.assign(this, { code, terminal, retryAfter, status });
  }
}
export function failure(error) {
  return error instanceof MonitorError ? error : new MonitorError('UNEXPECTED_ERROR');
}
export function backoff(attempt, retryAfter = 0, random = Math.random) {
  return Math.min(86400, Math.max(retryAfter, Math.min(3600, 15 * 2 ** (attempt - 1)) * (1 + random())));
}
export async function request(url, options = {}, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { ...options, signal: options.signal || AbortSignal.timeout(30000), redirect: 'error' }); }
  catch { throw new MonitorError('NETWORK_ERROR'); }
  if (!response.ok) {
    const header = response.headers.get('retry-after');
    const retryAfter = header ? (/^\d+$/.test(header) ? Number(header) : Math.max(0, (Date.parse(header) - Date.now()) / 1000)) : 0;
    throw new MonitorError(`HTTP_${response.status}`, { status: response.status, retryAfter: retryAfter || 0,
      terminal: [400, 401, 403].includes(response.status) });
  }
  if (response.status === 204) return null;
  try { return await response.json(); } catch { throw new MonitorError('INVALID_RESPONSE'); }
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
      headers: { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
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
}
// Allowlist log fields; callers cannot accidentally serialize payloads/tokens/errors.
export async function log(event, fields = {}) {
  const row = { timestamp: new Date().toISOString(), event };
  for (const key of ['job_id', 'source_id', 'attempt', 'records_processed', 'error_code']) {
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
