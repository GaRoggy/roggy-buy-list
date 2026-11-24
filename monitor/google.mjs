import { readFile, writeFile, rename, unlink, open, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  const tokenFile = env.GOOGLE_REFRESH_TOKEN ? null : '.secrets/google.tokens.json';
  let refresh;
  try { refresh = env.GOOGLE_REFRESH_TOKEN || protect(await readFile(tokenFile, 'utf8'), true); }
  catch { throw new MonitorError('GOOGLE_OAUTH_REQUIRED', { terminal: true }); }
  let token, expiry = 0, refreshPromise = null;
  const persistRotatedRefreshToken = async (expected, next) => {
    if (!tokenFile || !next || next === expected) return;
    const lockPath = `${tokenFile}.lock`;
    let lock;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { lock = await open(lockPath, 'wx'); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > 30000) { await unlink(lockPath); continue; }
        } catch (statError) { if (statError.code === 'ENOENT') continue; throw statError; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!lock) throw new MonitorError('GOOGLE_TOKEN_STORE_BUSY', { retryable: true });
    const temporary = `${tokenFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const current = protect(await readFile(tokenFile, 'utf8'), true);
      // Another worker may have already committed a newer token. Never replace it
      // with a credential derived from the token this worker started with.
      if (current !== expected) return;
      await writeFile(temporary, protect(next), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, tokenFile);
    } finally {
      await unlink(temporary).catch(() => {});
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  };
  const refreshAccessToken = async () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      let data;
      try {
        data = await request('https://oauth2.googleapis.com/token', { method: 'POST',
          body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
            refresh_token: refresh, grant_type: 'refresh_token' }) }, fetcher);
      } catch (error) {
        if (error?.code === 'HTTP_400' && /invalid_grant/i.test(String(error.cause || ''))) {
          throw new MonitorError('GOOGLE_REFRESH_TOKEN_INVALID', { terminal: true, status: 400,
            operation: 'google.oauth.token', cause: 'invalid_grant' });
        }
        throw error;
      }
      if (!data.access_token) throw new MonitorError('GOOGLE_OAUTH_REQUIRED', { terminal: true });
      const previous = refresh;
      if (data.refresh_token && data.refresh_token !== refresh) {
        await persistRotatedRefreshToken(refresh, data.refresh_token);
        if (tokenFile) {
          const latest = protect(await readFile(tokenFile, 'utf8'), true);
          refresh = latest === previous ? data.refresh_token : latest;
        }
      }
      token = data.access_token;
      expiry = Date.now() + (Math.max(60, Number(data.expires_in) || 3600) - 60) * 1000;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };
  const call = async (path, params = {}, raw = false, options = {}, retriedUnauthorized = false) => {
    if (!/^(calendar\/v3\/|gmail\/v1\/users\/me\/|tasks\/v1\/|people\/v1\/|drive\/v3\/)/.test(path)) throw new MonitorError('GOOGLE_PATH_DENIED', { terminal: true });
    if (Date.now() >= expiry) await refreshAccessToken();
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
    if (response.status === 401 && method === 'GET' && !retriedUnauthorized) {
      expiry = 0;
      await refreshAccessToken();
      return call(path, params, raw, options, true);
    }
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
