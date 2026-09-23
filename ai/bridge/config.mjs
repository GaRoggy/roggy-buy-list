export function config(env = process.env) {
  const required = name => { if (!env[name]?.trim()) throw Error(`Configure ${name}`); return env[name].trim(); };
  const integer = (name, fallback, min, max) => {
    const n = Number(env[name] || fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw Error(`Invalid ${name}`);
    return n;
  };
  const supabase = new URL(required('SUPABASE_URL'));
  if (supabase.protocol !== 'https:' || supabase.username || supabase.password || supabase.search || supabase.hash || supabase.pathname !== '/') throw Error('SUPABASE_URL must be an HTTPS origin');
  const anonKey = required('SUPABASE_ANON_KEY');
  let anon = anonKey.startsWith('sb_publishable_');
  if (anonKey.startsWith('eyJ')) { try { anon = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url')).role === 'anon'; } catch {} }
  if (!anon) throw Error('Use a publishable/anon Supabase key, never a service-role/secret key');
  const owner = required('OLLAMA_ALLOWED_USER_ID');
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(owner)) throw Error('OLLAMA_ALLOWED_USER_ID must be the owner UUID');
  const ollama = new URL(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
  if (ollama.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(ollama.hostname) ||
      ollama.username || ollama.password || ollama.search || ollama.hash || ollama.pathname !== '/') throw Error('OLLAMA_BASE_URL must be loopback HTTP only');
  const origins = required('OLLAMA_ALLOWED_ORIGINS').split(',').map(s => s.trim());
  for (const origin of origins) {
    const u = new URL(origin);
    if (u.origin !== origin || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw Error('Configure exact HTTPS origins (loopback HTTP allowed for development)');
  }
  const port = integer('OLLAMA_BRIDGE_PORT', 8787, 1024, 65535);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (env.OLLAMA_BRIDGE_URL) {
    const u = new URL(env.OLLAMA_BRIDGE_URL);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('OLLAMA_BRIDGE_URL must be an HTTPS origin');
    hosts.add(u.host);
  }
  return { supabase: supabase.origin, anonKey, owner, ollama: ollama.origin, origins: new Set(origins), hosts, port,
    timeoutMs: integer('OLLAMA_TIMEOUT_MS', 180000, 1000, 600000),
    maxTokens: integer('OLLAMA_MAX_TOKENS', 2048, 1, 8192), contextTokens: integer('OLLAMA_CONTEXT_TOKENS', 16384, 2048, 65536) };
}
