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
  return async (path, params = {}) => {
    if (!/^(calendar\/v3\/|gmail\/v1\/users\/me\/)/.test(path)) throw new MonitorError('GOOGLE_PATH_DENIED', { terminal: true });
    if (Date.now() >= expiry) {
      const data = await request('https://oauth2.googleapis.com/token', { method: 'POST',
        body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: refresh, grant_type: 'refresh_token' }) }, fetcher);
      if (!data.access_token) throw new MonitorError('GOOGLE_OAUTH_REQUIRED', { terminal: true });
      token = data.access_token; expiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    }
    return request(`https://www.googleapis.com/${path}?${new URLSearchParams(params)}`,
      { headers: { Authorization: `Bearer ${token}` } }, fetcher);
  };
}
