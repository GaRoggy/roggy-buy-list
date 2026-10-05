// Provider-neutral text protocol, shared by the browser and local service.
export const LIMITS = Object.freeze({ bodyBytes: 65536, messages: 40, messageChars: 12000, totalChars: 48000, outputChars: 64000 });
const DEFAULT_MESSAGES = Object.freeze({
  OLLAMA_OFFLINE: 'The local model service is unavailable.',
  OLLAMA_TIMEOUT: 'The local model did not respond before the time limit.',
  MODEL_UNAVAILABLE: 'The requested local model is unavailable.',
  NETWORK_UNAVAILABLE: 'NetworkWatch is temporarily unavailable.',
  CAMERA_UNAVAILABLE: 'The camera service is unavailable.',
  SMART_HOME_UNAVAILABLE: 'The smart-home service is unavailable.',
  INTERNAL_ERROR: 'The request could not be completed.',
});
export const boundedText = (value, limit = 1024) => {
  if (value === undefined || value === null) return null;
  let text = String(value).replace(/\s+/g, ' ').trim();
  text = text.replace(/(authorization|bearer|token|secret|password|cookie)\s*[:=]\s*(?:bearer\s+)?[^,\s}]+/ig, '$1=[redacted]');
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 14)).trimEnd()}… [truncated]`;
};
const boundedDetails = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 12)) {
    result[boundedText(key, 64) || 'detail'] = typeof item === 'string'
      ? boundedText(item, 512)
      : Array.isArray(item) ? item.slice(0, 12).map(part => boundedText(part, 256))
        : item && typeof item === 'object' ? boundedText(JSON.stringify(item), 512) : item;
  }
  return result;
};
export class AIError extends Error {
  constructor(code, status = 400, { message = null, operation = null, cause = null, target = null,
    retryable = status === 408 || status === 429 || status >= 500, details = {} } = {}) {
    super(boundedText(message, 240) || DEFAULT_MESSAGES[code] || code);
    this.code = boundedText(code, 96) || 'UNKNOWN_ERROR'; this.status = status;
    this.operation = boundedText(operation, 128); this.cause = boundedText(cause, 512);
    this.target = boundedText(target, 256); this.retryable = Boolean(retryable);
    this.details = boundedDetails(details);
  }
  toJSON(requestId = null) {
    return {
      error_code: this.code, code: this.code, subsystem: 'website_bridge',
      operation: this.operation, message: this.message, cause: this.cause,
      status_code: this.status, target: this.target, retryable: this.retryable,
      timestamp: new Date().toISOString(), correlation_id: requestId, details: this.details,
    };
  }
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
        if (line) { try { yield JSON.parse(line); } catch (e) { if (e instanceof AIError) throw e; throw new AIError('INVALID_RESPONSE', 502, { cause: 'JSONParseError', details: { line_length: line.length } }); } }
      }
      if (pending.length > maxLine) throw new AIError('INVALID_RESPONSE', 502);
      if (done) break;
    }
    if (pending.trim()) { try { yield JSON.parse(pending); } catch { throw new AIError('INVALID_RESPONSE', 502, { cause: 'JSONParseError', details: { line_length: pending.trim().length } }); } }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
