import { AIError, validateRequest } from './shared/protocol.js';
import { OllamaProvider } from './providers/ollama.mjs';

// Text processing only. Collectors and storage remain separate, explicitly invoked layers.
// No cloud fallback, file access, tools, command execution or collector auto-ingestion.
export function createAI(cfg, fetcher = fetch) {
  const providers = new Map([['ollama', new OllamaProvider(cfg, fetcher)]]);
  return {
    models(signal) { return providers.get('ollama').models(signal); },
    chat(input, signal) {
      const request = validateRequest(input), provider = providers.get(request.provider);
      if (!provider) throw new AIError('PROVIDER_UNAVAILABLE');
      return provider.chat(request, signal);
    }
  };
}
