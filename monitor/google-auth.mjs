import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { request, failure, MonitorError, config, Store } from './core.mjs';
import { protect } from './google.mjs';

async function authorize() {
  const { GOOGLE_CLIENT_ID: client_id, GOOGLE_CLIENT_SECRET: client_secret } = process.env;
  if (!client_id || !client_secret) throw new MonitorError('GOOGLE_CLIENT_CONFIG_REQUIRED');
  const state = randomBytes(32).toString('hex'), verifier = randomBytes(64).toString('base64url');
  const scopes = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/tasks.readonly',
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/drive.readonly'
  ];
  let redirect, busy = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, redirect);
    const actual = url.searchParams.get('state') || '';
    if (req.method !== 'GET' || url.pathname !== '/' || !/^[a-f0-9]{64}$/.test(actual) || !timingSafeEqual(Buffer.from(actual), Buffer.from(state))) {
      res.writeHead(400); res.end('Invalid authorization response.'); return;
    }
    if (busy) { res.writeHead(409); res.end(); return; } busy = true;
    try {
      if (!url.searchParams.get('code')) throw new MonitorError('GOOGLE_CONSENT_DENIED');
      const tokens = await request('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
        client_id, client_secret, code: url.searchParams.get('code'), code_verifier: verifier,
        redirect_uri: redirect, grant_type: 'authorization_code' }) });
      if (!tokens.refresh_token || !scopes.every(s => (tokens.scope || '').split(' ').includes(s))) throw new MonitorError('GOOGLE_SCOPES_INCOMPLETE');
      await mkdir('.secrets', { recursive: true });
      const tokenPath = '.secrets/google.tokens.json', temporary = `${tokenPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, protect(tokens.refresh_token), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, tokenPath);
      } finally { await unlink(temporary).catch(() => {}); }
      try {
        const env = config(), store = new Store(env);
        const query = new URLSearchParams({ user_id: `eq.${env.MONITOR_USER_ID}`,
          kind: 'in.(gmail,calendar,google_tasks,google_people,google_drive)' });
        await store.api(`monitor_sources?${query}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ next_run_at: new Date().toISOString(), error_code: null }) });
      } catch (error) {
        console.error(`GOOGLE_SOURCE_RESCHEDULE_FAILED:${failure(error).code}`);
      }
      res.end('Read-only authorization saved with Windows user encryption. You can close this tab.');
      console.log('Google authorization saved with contact-edit permission. Start the worker using this same Windows account.');
    } catch (e) { res.writeHead(400); res.end('Authorization failed; see the local error code.'); console.error(failure(e).code); process.exitCode = 1; }
    finally { clearTimeout(timeout); server.close(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  redirect = `http://127.0.0.1:${server.address().port}/`;
  const timeout = setTimeout(() => { server.close(); console.error('OAUTH_TIMEOUT'); process.exitCode = 1; }, 300000);
  console.log('Open this URL on this PC and approve the requested Google access:\n' +
    'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id, redirect_uri: redirect,
      response_type: 'code', scope: scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' }));
}
authorize().catch(e => { console.error(failure(e).code); process.exitCode = 1; });
