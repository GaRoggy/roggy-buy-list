import { AIError, LIMITS, readNDJSON } from '../shared/protocol.js';

const remote = m => !!(m.remote_host || m.remote_model || /(?:^|[:/-])cloud(?:$|[:/-])/i.test(m.name || ''));
export class OllamaProvider {
  id = 'ollama';
  constructor(cfg, fetcher = fetch) { this.cfg = cfg; this.fetcher = fetcher; }
  async request(path, signal, body) {
    const started = Date.now();
    let response;
    try {
      response = await this.fetcher(this.cfg.ollama + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new AIError(timedOut ? 'OLLAMA_TIMEOUT' : 'OLLAMA_OFFLINE', timedOut ? 504 : 503, {
        operation: path, cause: error?.name || 'FetchError', retryable: true,
        details: { elapsed_ms: Date.now() - started },
      });
    }
    if (!response.ok) {
      const excerpt = await response.text().catch(() => '');
      throw new AIError(response.status === 404 ? 'MODEL_UNAVAILABLE' : 'MODEL_ERROR',
        response.status, { operation: path, target: this.cfg.ollama, retryable: response.status === 429 || response.status >= 500,
          cause: excerpt, details: { elapsed_ms: Date.now() - started, diagnostic_code: response.status === 404 ? 'MODEL_UNAVAILABLE' : `OLLAMA_HTTP_${response.status}` } });
    }
    return response;
  }
  async json(path, signal, body) {
    const response = await this.request(path, signal, body);
    try { return await response.json(); } catch { throw new AIError('INVALID_RESPONSE', 502, { operation: path, cause: 'JSONParseError' }); }
  }
  async models(signal) {
    const data = await this.json('/api/tags', signal);
    if (!Array.isArray(data.models)) throw new AIError('INVALID_RESPONSE', 502, { operation: '/api/tags', cause: 'models_not_array' });
    return data.models.filter(m => typeof m.name === 'string' && !remote(m)).map(m => ({ id: m.name, name: m.name, provider: this.id }));
  }
  async *chat({ model, messages }, signal) {
    if (!(await this.models(signal)).some(m => m.id === model)) throw new AIError('MODEL_UNAVAILABLE', 404);
    const details = await this.json('/api/show', signal, { model });
    if (remote({ ...details, name: model })) throw new AIError('LOCAL_MODELS_ONLY', 403);
    const response = await this.request('/api/chat', signal, { model, messages, stream: true, think: false,
      options: { num_predict: this.cfg.maxTokens, num_ctx: this.cfg.contextTokens }, keep_alive: '5m' });
    let chars = 0;
    for await (const chunk of readNDJSON(response.body)) {
      if (chunk.error) throw new AIError('MODEL_ERROR', 502, { operation: '/api/chat', cause: chunk.error });
      const text = chunk.message?.content;
      if (text !== undefined && typeof text !== 'string') throw new AIError('INVALID_RESPONSE', 502);
      if (text) {
        chars += text.length;
        if (chars > LIMITS.outputChars) throw new AIError('OUTPUT_LIMIT', 502);
        yield { type: 'delta', text };
      }
      if (chunk.done === true) { yield { type: 'done', reason: chunk.done_reason === 'length' ? 'length' : 'stop' }; return; }
    }
    throw new AIError('INCOMPLETE_RESPONSE', 502);
  }
}
