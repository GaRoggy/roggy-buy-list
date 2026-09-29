import { AIError, LIMITS, readNDJSON, validateRequest } from '../shared/protocol.js';

export function createBridgeProvider({ bridgeUrl, getSession, isAuthorized }) {
  let url;
  try { url = new URL(bridgeUrl); } catch { throw new AIError('NOT_CONFIGURED'); }
  const local = ['localhost', '127.0.0.1'].includes(location.hostname) && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new AIError('INVALID_CONFIG');
  async function request(path, signal, input) {
    const { data, error } = await getSession(); signal.throwIfAborted();
    if (error || !isAuthorized(data?.session) || !data.session.access_token) throw new AIError('UNAUTHORIZED', 401);
    let response;
    try {
      response = await fetch(url.origin + path, { method: input ? 'POST' : 'GET', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Authorization: `Bearer ${data.session.access_token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, body: input ? JSON.stringify(input) : undefined });
    } catch (e) { if (signal.aborted) throw signal.reason; throw new AIError('BRIDGE_OFFLINE', 503); }
    if (!response.ok) {
      let error; try { error = (await response.json()).error; } catch {}
      throw new AIError(typeof error === 'string' ? error : 'BRIDGE_ERROR', response.status);
    }
    return response;
  }
  return {
    async models(signal) {
      const response = await request('/api/models', signal), data = await response.json();
      if (!Array.isArray(data.models)) throw new AIError('INVALID_RESPONSE');
      return data.models.filter(m => m.provider === 'ollama' && typeof m.id === 'string' && typeof m.name === 'string');
    },
    async *chat(input, signal) {
      validateRequest(input);
      if (new TextEncoder().encode(JSON.stringify(input)).length > LIMITS.bodyBytes) throw new AIError('REQUEST_TOO_LARGE');
      const response = await request('/api/chat', signal, input); let length = 0;
      for await (const event of readNDJSON(response.body)) {
        if (event.type === 'error') throw new AIError(event.error || 'MODEL_ERROR');
        if (event.type === 'delta') {
          if (typeof event.text !== 'string' || (length += event.text.length) > LIMITS.outputChars) throw new AIError('INVALID_RESPONSE');
          yield event;
        } else if (event.type === 'done') { yield event; return; }
        else if (event.type !== 'ping') throw new AIError('INVALID_RESPONSE');
      }
      throw new AIError('INCOMPLETE_RESPONSE');
    }
  };
}
