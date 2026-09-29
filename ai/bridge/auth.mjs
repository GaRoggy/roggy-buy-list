import { AIError } from '../shared/protocol.js';

// Remote verification on every request: never trust decoded JWT/user_metadata.
export async function authorize(header, cfg, signal, fetcher = fetch) {
  if (typeof header !== 'string' || header.length > 8192 || !/^Bearer [A-Za-z0-9._~-]+$/.test(header)) throw new AIError('UNAUTHORIZED', 401);
  let response;
  try {
    response = await fetcher(`${cfg.supabase}/auth/v1/user`, { headers: { apikey: cfg.anonKey, Authorization: header },
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), redirect: 'error' });
  } catch { throw new AIError('AUTH_UNAVAILABLE', 503); }
  if (!response.ok) { await response.body?.cancel(); throw new AIError(response.status >= 500 || response.status === 429 ? 'AUTH_UNAVAILABLE' : 'UNAUTHORIZED', response.status >= 500 || response.status === 429 ? 503 : 401); }
  let user;
  try { user = await response.json(); } catch { throw new AIError('AUTH_UNAVAILABLE', 503); }
  if (!user?.id || user.id !== cfg.owner || user.is_anonymous === true) throw new AIError('FORBIDDEN', 403);
  return user.id;
}
