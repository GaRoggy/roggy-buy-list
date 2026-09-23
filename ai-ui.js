import { createBridgeProvider } from './ai/browser/provider.js';
import { LIMITS, validateRequest } from './ai/shared/protocol.js';

const el = id => document.getElementById(id);
const messages = [], history = [];
let provider, generation, checking, signedIn = false, online = false, epoch = 0;
const errors = {
  NOT_CONFIGURED: 'Connect your PC first: complete the private Tailscale bridge setup in docs/ollama-setup.md.',
  INVALID_CONFIG: 'The configured bridge address is invalid. Use your PC’s private Tailscale HTTPS address.',
  UNAUTHORIZED: 'Your session expired. Sign out and sign in again.', FORBIDDEN: 'This account is not authorized to use the bridge.',
  AUTH_UNAVAILABLE: 'The bridge cannot verify your Supabase session. Check the PC’s internet connection.',
  BRIDGE_OFFLINE: 'Cannot reach your PC. Connect Tailscale on this device and check that the PC and AI bridge are running. Allow local-network access if your browser requests it.',
  OLLAMA_OFFLINE: 'The bridge is reachable, but Ollama is offline. Start Ollama on your PC, then reconnect.',
  MODEL_UNAVAILABLE: 'That model is no longer available locally. Refresh models and select another.',
  LOCAL_MODELS_ONLY: 'Only locally installed models are allowed. Cloud models are disabled.',
  MODEL_ERROR: 'Ollama could not run this model. Check available memory and the Ollama log on your PC.',
  BUSY: 'Your PC is already handling an AI request. Wait for it to finish, then retry.',
  RATE_LIMITED: 'Too many requests. Wait one minute before trying again.',
  GENERATION_TIMEOUT: 'Generation timed out. Try a shorter prompt or a smaller model.',
  REQUEST_TIMEOUT: 'The request timed out. Check your connection and try again.',
  INVALID_REQUEST: 'This conversation is too long. Clear it and start a new one (up to 40 messages and 48,000 characters).',
  REQUEST_TOO_LARGE: 'This conversation is too large. Clear it and start a shorter one.',
  INCOMPLETE_RESPONSE: 'The connection ended before the response finished. The incomplete reply is excluded from follow-up context.',
  OUTPUT_LIMIT: 'The reply exceeded the output limit. Ask for a shorter answer.',
  BRIDGE_STOPPING: 'The bridge is restarting. Reconnect in a moment.'
};
function message(error) { return errors[error?.code] || (error?.name === 'TimeoutError' ? errors.GENERATION_TIMEOUT : 'The AI request failed. Check the bridge and reconnect.'); }
function status(text, state) { el('aiConnection').textContent = text; el('aiConnection').dataset.state = state; }
function controls() {
  const busy = !!generation;
  el('aiSend').disabled = busy || !signedIn || !online || !el('aiModel').value || !el('aiPrompt').value.trim();
  el('aiStop').hidden = !busy; el('aiModel').disabled = busy || !online;
  el('aiRefresh').disabled = busy || !!checking || !signedIn;
  el('aiGenerating').hidden = !busy; el('aiHistory').setAttribute('aria-busy', String(busy));
  el('aiPrompt').disabled = busy || !signedIn;
}
function addMessage(role, content) {
  const card = document.createElement('article'); card.className = `ai-message ai-${role}`;
  const label = document.createElement('b'); label.textContent = role === 'user' ? 'You' : 'Local AI';
  const text = document.createElement('div'); text.className = 'ai-message-text'; text.textContent = content;
  const note = document.createElement('small'); card.append(label, text, note); el('aiHistory').append(card);
  el('aiEmpty').hidden = true; messages.push(card); return { card, text, note };
}
function clearConversation() {
  epoch++; generation?.abort(); generation = null; history.length = 0; messages.length = 0;
  el('aiHistory').replaceChildren(); el('aiEmpty').hidden = false; el('aiError').textContent = ''; el('aiPrompt').value = ''; controls();
}
async function refresh() {
  if (!signedIn || generation || checking) return;
  const ticket = epoch, controller = new AbortController(); checking = controller; online = false;
  status('Connecting…', 'checking'); controls();
  try {
    provider ||= createBridgeProvider({ bridgeUrl: window.ROGGY_AI_CONFIG?.bridgeUrl, getSession: () => sb.auth.getSession(), isAuthorized: isOwnerSession });
    const models = await provider.models(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
    if (ticket !== epoch) return;
    const current = el('aiModel').value; let saved = ''; try { saved = localStorage.getItem('roggy-ai-model') || ''; } catch {}
    el('aiModel').replaceChildren(...models.map(m => { const option = document.createElement('option'); option.value = m.id; option.textContent = m.name; return option; }));
    const selected = models.find(m => m.id === current) || models.find(m => m.id === saved) || models[0];
    if (selected) el('aiModel').value = selected.id;
    online = true; status(models.length ? 'Ollama online · private' : 'Online · no local models', 'online');
    el('aiError').textContent = models.length ? '' : 'Install a local model in Ollama on your PC, then refresh models.';
  } catch (error) {
    if (ticket !== epoch || controller.signal.aborted) return;
    status(error.code === 'NOT_CONFIGURED' ? 'Setup needed' : 'AI unavailable', 'offline'); el('aiError').textContent = message(error);
  } finally { if (checking === controller) checking = null; controls(); }
}
async function send(event) {
  event.preventDefault(); if (el('aiSend').disabled) return;
  const content = el('aiPrompt').value.trim(), model = el('aiModel').value;
  const input = { provider: 'ollama', model, messages: [...history, { role: 'user', content }] };
  try { validateRequest(input); } catch (e) { el('aiError').textContent = message(e); return; }
  const ticket = epoch, controller = new AbortController(); generation = controller;
  const user = addMessage('user', content), reply = addMessage('assistant', '');
  el('aiPrompt').value = ''; el('aiError').textContent = ''; controls(); let full = '', complete = false;
  try {
    for await (const event of provider.chat(input, AbortSignal.any([controller.signal, AbortSignal.timeout(615000)]))) {
      if (ticket !== epoch) return;
      if (event.type === 'delta') {
        const box = el('aiHistory'), follow = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
        full += event.text; reply.text.textContent = full;
        if (follow) box.scrollTop = box.scrollHeight;
      } else if (event.type === 'done') {
        complete = !!full.trim();
        reply.note.textContent = event.reason === 'length' ? 'Output limit reached.' : '';
      }
    }
    if (complete) {
      // Do not silently truncate history or exceed the per-message context bound.
      if (full.length <= LIMITS.messageChars) history.push({ role: 'user', content }, { role: 'assistant', content: full });
      else { online = false; reply.note.textContent = 'Reply too long for follow-up context. Clear this conversation before continuing.'; }
    } else { reply.note.textContent = 'No text returned. Try another model.'; el('aiPrompt').value = content; }
  } catch (error) {
    if (ticket !== epoch) return;
    reply.note.textContent = controller.signal.aborted ? 'Stopped · excluded from follow-up context.' : 'Incomplete · excluded from follow-up context.';
    user.note.textContent = 'This turn was not added to follow-up context.';
    el('aiPrompt').value = content;
    if (!controller.signal.aborted) {
      el('aiError').textContent = message(error);
      if (['BRIDGE_OFFLINE', 'OLLAMA_OFFLINE', 'UNAUTHORIZED', 'FORBIDDEN', 'AUTH_UNAVAILABLE'].includes(error.code)) { online = false; status('AI unavailable', 'offline'); }
    }
  } finally {
    if (generation === controller) generation = null;
    if (ticket === epoch) { controls(); el('aiPrompt').focus({ preventScroll: true }); }
  }
}
el('aiForm').addEventListener('submit', send);
el('aiPrompt').maxLength = LIMITS.messageChars;
el('aiPrompt').addEventListener('input', controls);
el('aiPrompt').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); el('aiForm').requestSubmit(); } });
el('aiStop').onclick = () => generation?.abort();
el('aiClear').onclick = () => { clearConversation(); if (signedIn) refresh(); };
el('aiRefresh').onclick = refresh;
el('aiModel').onchange = () => { try { localStorage.setItem('roggy-ai-model', el('aiModel').value); } catch {} controls(); };
window.addEventListener('roggy-page', e => { if (e.detail.page === 'ai') refresh(); });
function authChanged(session) {
  const authorized = isOwnerSession(session);
  if (!authorized) { checking?.abort(); checking = null; clearConversation(); online = false; status('Sign in required', 'offline'); }
  signedIn = authorized; controls(); if (signedIn && !el('aiPage').hidden) refresh();
}
window.addEventListener('roggy-auth', e => { if (!e.detail.signedIn) authChanged(null); else setTimeout(() => sb.auth.getSession().then(({data}) => authChanged(data.session)).catch(() => authChanged(null)), 0); });
sb.auth.getSession().then(({ data }) => authChanged(data.session)).catch(() => authChanged(null));
controls();
