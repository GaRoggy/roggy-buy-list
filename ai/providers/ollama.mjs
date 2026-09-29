import { AIError, LIMITS, readNDJSON } from '../shared/protocol.js';

const remote = m => !!(m.remote_host || m.remote_model || /(?:^|[:/-])cloud(?:$|[:/-])/i.test(m.name || ''));
export class OllamaProvider {
  id = 'ollama';
  constructor(cfg, fetcher = fetch) { this.cfg = cfg; this.fetcher = fetcher; }
  async request(path, signal, body) {
    let response;
    try {
      response = await this.fetcher(this.cfg.ollama + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch { if (signal.aborted) throw signal.reason; throw new AIError('OLLAMA_OFFLINE', 503); }
    if (!response.ok) { await response.body?.cancel(); throw new AIError(response.status === 404 ? 'MODEL_UNAVAILABLE' : 'MODEL_ERROR', 502); }
    return response;
  }
  async json(path, signal, body) {
    const response = await this.request(path, signal, body);
    try { return await response.json(); } catch { throw new AIError('INVALID_RESPONSE', 502); }
  }
  async models(signal) {
    const data = await this.json('/api/tags', signal);
    if (!Array.isArray(data.models)) throw new AIError('INVALID_RESPONSE', 502);
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
      if (chunk.error) throw new AIError('MODEL_ERROR', 502);
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
