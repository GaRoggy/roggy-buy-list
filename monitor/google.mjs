import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { request, MonitorError } from './core.mjs';

export function protect(value, decrypt = false) {
  if (process.platform !== 'win32') throw new MonitorError('WINDOWS_SECRET_STORE_REQUIRED', { terminal: true });
  const script = decrypt
    ? "[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    : "[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $v=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new MonitorError('SECRET_STORE_ERROR', { terminal: true });
  return result.stdout.trim();
}
export async function googleClient(env, fetcher = fetch) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new MonitorError('GOOGLE_OAUTH_REQUIRED', { terminal: true });
  let refresh = env.GOOGLE_REFRESH_TOKEN;
  if (!refresh) {
    try { refresh = protect(await readFile('.secrets/google.tokens.json', 'utf8'), true); }
    catch { throw new MonitorError('GOOGLE_OAUTH_REQUIRED', { terminal: true }); }
  }
  let token, expiry = 0;
  const call = async (path, params = {}, raw = false, options = {}) => {
    if (!/^(calendar\/v3\/|gmail\/v1\/users\/me\/|tasks\/v1\/|people\/v1\/|drive\/v3\/)/.test(path)) throw new MonitorError('GOOGLE_PATH_DENIED', { terminal: true });
    if (Date.now() >= expiry) {
      const data = await request('https://oauth2.googleapis.com/token', { method: 'POST',
        body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: refresh, grant_type: 'refresh_token' }) }, fetcher);
      if (!data.access_token) throw new MonitorError('GOOGLE_OAUTH_REQUIRED', { terminal: true });
      token = data.access_token; expiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    }
    const method = String(options.method || 'GET').toUpperCase();
    const query = new URLSearchParams(params);
    const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
    const init = { method, headers, signal: AbortSignal.timeout(30000), redirect: 'error' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const peopleApi = path.startsWith('people/v1/');
    const apiHost = peopleApi ? 'https://people.googleapis.com/' : 'https://www.googleapis.com/';
    const apiPath = peopleApi ? path.slice('people/'.length) : path;
    let response;
    try { response = await fetcher(`${apiHost}${apiPath}${query.toString() ? `?${query}` : ''}`, init); }
    catch { throw new MonitorError('NETWORK_ERROR'); }
    if (!response.ok) {
      const header = response.headers.get('retry-after');
      const retryAfter = header ? (/^\d+$/.test(header) ? Number(header) : Math.max(0, (Date.parse(header) - Date.now()) / 1000)) : 0;
      throw new MonitorError(`HTTP_${response.status}`, { status: response.status, retryAfter: retryAfter || 0,
        terminal: [400, 401, 403].includes(response.status) });
    }
    if (raw) return { contentType: response.headers.get('content-type') || '', body: await response.arrayBuffer() };
    try {
      const body = await response.text();
      return body.trim() ? JSON.parse(body) : null;
    } catch { throw new MonitorError('INVALID_RESPONSE'); }
  };
  const get = (path, params = {}) => call(path, params, false);
  get.raw = (path, params = {}) => call(path, params, true);
  // Writes are intentionally exposed as a narrow method on the same
  // allowlisted client. Callers still cannot reach arbitrary hosts or paths.
  get.request = (path, options = {}) => call(path, options.params || {}, false, options);
  get.rawRequest = (path, options = {}) => call(path, options.params || {}, true, options);
  return get;
}
