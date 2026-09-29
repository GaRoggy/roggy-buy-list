// Provider-neutral text protocol, shared by the browser and local service.
export const LIMITS = Object.freeze({ bodyBytes: 65536, messages: 40, messageChars: 12000, totalChars: 48000, outputChars: 64000 });
export class AIError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function validateRequest(value) {
  const fail = () => { throw new AIError('INVALID_REQUEST'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['provider', 'model', 'messages'].includes(k))) fail();
  if (value.provider !== 'ollama') throw new AIError('PROVIDER_UNAVAILABLE');
  if (typeof value.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value.model)) fail();
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > LIMITS.messages) fail();
  let total = 0;
  value.messages.forEach((m, i) => {
    if (!m || Object.keys(m).some(k => !['role', 'content'].includes(k)) ||
        m.role !== (i % 2 === 0 ? 'user' : 'assistant') || typeof m.content !== 'string' ||
        !m.content.trim() || m.content.length > LIMITS.messageChars) fail();
    total += m.content.length;
  });
  if (value.messages.at(-1).role !== 'user' || total > LIMITS.totalChars) fail();
  return { provider: value.provider, model: value.model, messages: value.messages.map(({ role, content }) => ({ role, content })) };
}
// Bounded NDJSON reader; handles UTF-8 and records split across network chunks.
export async function* readNDJSON(body, maxLine = 262144) {
  if (!body) throw new AIError('INVALID_RESPONSE', 502);
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        if (newline > maxLine) throw new AIError('INVALID_RESPONSE', 502);
        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
        if (line) { try { yield JSON.parse(line); } catch (e) { if (e instanceof AIError) throw e; throw new AIError('INVALID_RESPONSE', 502); } }
      }
      if (pending.length > maxLine) throw new AIError('INVALID_RESPONSE', 502);
      if (done) break;
    }
    if (pending.trim()) { try { yield JSON.parse(pending); } catch { throw new AIError('INVALID_RESPONSE', 502); } }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
