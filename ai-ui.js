import { createBridgeProvider } from './ai/browser/provider.js';
import { LIMITS } from './ai/shared/protocol.js';
import { createTranscriptStore, formatTranscriptLine, roomLabel } from './transcript.js?v=2';
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

const transcriptStore = createTranscriptStore();
const transcriptTimeZone = window.ROGGY_AI_CONFIG?.transcriptTimeZone || 'America/Chicago';
let transcriptFilter = 'all', transcriptFollowing = true, transcriptStreamStatus = 'disconnected', transcriptHealthTimer = null, transcriptBound = false;
const microphoneCatalog = new Map();

function transcriptStatus(text, state) {
  const target = el('liveTranscriptStatus');
  if (!target) return;
  target.textContent = text;
  target.dataset.state = state;
}
function transcriptFilterOptions() {
  const select = el('liveTranscriptFilter');
  if (!select) return;
  const entries = transcriptStore.list('all');
  const microphones = new Map(microphoneCatalog);
  for (const entry of entries) {
    const ids = entry.microphone_ids || (entry.microphone_id ? [entry.microphone_id] : []);
    for (const microphoneId of ids) microphones.set(microphoneId, entry.friendly_name || roomLabel(entry.room) || microphoneId);
  }
  const values = [...microphones.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const current = transcriptFilter;
  select.replaceChildren(new Option('All microphones', 'all'), ...values.map(([id, name]) => new Option(name, id)));
  select.value = values.some(([id]) => id === current) || current === 'all' ? current : 'all';
  transcriptFilter = select.value;
}
function renderTranscript() {
  const log = el('liveTranscriptLog'), empty = el('liveTranscriptEmpty');
  if (!log || !empty) return;
  transcriptFilterOptions();
  const entries = transcriptStore.list(transcriptFilter);
  log.replaceChildren(...entries.map(entry => {
    const row = document.createElement('article');
    row.className = `live-transcript-entry ${entry.kind === 'assistant' ? 'layne-response' : 'voice-user'}`;
    row.textContent = formatTranscriptLine(entry, { timeZone: transcriptTimeZone });
    return row;
  }));
  empty.hidden = entries.length > 0;
  if (transcriptFollowing) log.scrollTop = log.scrollHeight;
}
function applyTranscriptHealth(diagnostics) {
  const bridge = diagnostics?.agent_bridge || {};
  const voice = diagnostics?.voice || {};
  for (const microphone of (Array.isArray(voice.microphones) ? voice.microphones : [])) {
    if (microphone?.microphone_id) microphoneCatalog.set(
      microphone.microphone_id,
      microphone.friendly_name || roomLabel(microphone.room) || microphone.microphone_id,
    );
  }
  transcriptFilterOptions();
  if (bridge.configured_microphones === 0) return transcriptStatus('No microphones connected', 'offline');
  if (voice.status === 'unavailable' || voice.transcriber_loaded === false || (voice.whisper && voice.whisper.ready === false)) return transcriptStatus('Whisper unavailable', 'offline');
  if (transcriptStreamStatus !== 'connected') return transcriptStatus('Disconnected', 'offline');
  transcriptStatus(voice.all_audio_streams_healthy === false ? 'Listening · microphone reconnecting' : 'Listening', voice.all_audio_streams_healthy === false ? 'checking' : 'online');
}
async function refreshTranscriptHealth() {
  if (!signedIn || !window.roggySmartHomeStream?.diagnostics) return;
  try { applyTranscriptHealth(await window.roggySmartHomeStream.diagnostics()); }
  catch { transcriptStatus('Disconnected', 'offline'); }
}
async function loadTranscriptHistory() {
  if (!signedIn || !window.roggySmartHomeStream?.history) return;
  try {
    const payload = await window.roggySmartHomeStream.history(100);
    for (const event of (Array.isArray(payload?.events) ? payload.events : [])) {
      if (event?.type === 'whisper_transcript' || event?.type === 'layne_voice_response') transcriptStore.ingest(event);
    }
    renderTranscript();
  } catch { transcriptStatus('Disconnected', 'offline'); }
}
function startTranscriptPanel() {
  if (!transcriptBound) {
    transcriptBound = true;
    el('liveTranscriptFilter')?.addEventListener('change', event => { transcriptFilter = event.target.value; renderTranscript(); });
    el('liveTranscriptLatest')?.addEventListener('click', () => { transcriptFollowing = true; const log = el('liveTranscriptLog'); if (log) log.scrollTop = log.scrollHeight; });
    el('liveTranscriptLog')?.addEventListener('scroll', event => {
      const log = event.currentTarget;
      transcriptFollowing = log.scrollHeight - log.scrollTop - log.clientHeight <= 48;
    });
    window.addEventListener('roggy-smart-home-event', event => {
      if (!['whisper_transcript', 'layne_voice_response'].includes(event.detail?.type)) return;
      if (event.detail?.type === 'whisper_transcript' && event.detail?.final === false) return;
      transcriptStore.ingest(event.detail);
      renderTranscript();
    });
    window.addEventListener('roggy-smart-home-stream-status', event => {
      transcriptStreamStatus = event.detail?.status || 'disconnected';
      if (transcriptStreamStatus === 'connected') refreshTranscriptHealth();
      else if (transcriptStreamStatus === 'connecting') transcriptStatus('Connecting…', 'checking');
      else transcriptStatus('Disconnected', 'offline');
    });
  }
  if (!signedIn) { transcriptStatus('Disconnected', 'offline'); return; }
  transcriptStreamStatus = window.roggySmartHomeStream?.status?.() || transcriptStreamStatus;
  window.roggySmartHomeStream?.connect?.();
  loadTranscriptHistory();
  refreshTranscriptHealth();
  if (!transcriptHealthTimer) transcriptHealthTimer = setInterval(() => { if (!document.hidden && !el('aiPage')?.hidden) refreshTranscriptHealth(); }, 15000);
}
function stopTranscriptPanel() {
  if (transcriptHealthTimer) { clearInterval(transcriptHealthTimer); transcriptHealthTimer = null; }
  transcriptStore.clear(); renderTranscript(); transcriptStreamStatus = 'disconnected'; transcriptStatus('Disconnected', 'offline');
}
function controls() {
  const busy = !!generation;
  el('aiSend').disabled = busy || !signedIn || !online || !el('aiPrompt').value.trim();
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
    online = true; status(models.length ? 'Layne online · private' : 'Layne online · model catalog unavailable', 'online');
    el('aiError').textContent = models.length ? '' : 'Layne is reachable, but no local model is currently listed.';
  } catch (error) {
    if (ticket !== epoch || controller.signal.aborted) return;
    status(error.code === 'NOT_CONFIGURED' ? 'Setup needed' : 'AI unavailable', 'offline'); el('aiError').textContent = message(error);
  } finally { if (checking === controller) checking = null; controls(); }
}
async function send(event) {
  event.preventDefault(); if (el('aiSend').disabled) return;
  const content = el('aiPrompt').value.trim();
  if (!content || content.length > LIMITS.messageChars) { el('aiError').textContent = 'Enter a shorter message.'; return; }
  if (typeof window.roggyLayneCommand !== 'function') { el('aiError').textContent = 'Layne command routing is unavailable. Refresh the page and reconnect.'; return; }
  const ticket = epoch, controller = new AbortController(); generation = controller;
  const user = addMessage('user', content), reply = addMessage('assistant', '');
  el('aiPrompt').value = ''; el('aiError').textContent = ''; controls(); let full = '', complete = false;
  try {
    const payload = await window.roggyLayneCommand(content, {
      context: { input_type: 'text', source: 'local_ai' },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(185000)]),
    });
    if (ticket !== epoch) return;
    full = typeof payload === 'string' ? payload : String(payload?.message || payload?.answer || payload?.result?.message || payload?.result || 'Layne returned a response without text.');
    complete = !!full.trim();
    reply.text.textContent = full;
    if (payload?.status === 'failed') reply.note.textContent = 'Layne reported that the action failed; no generic chat fallback was used.';
    if (complete) {
      // Do not silently truncate history or exceed the per-message context bound.
      if (full.length <= LIMITS.messageChars) history.push({ role: 'user', content }, { role: 'assistant', content: full });
      else { online = false; reply.note.textContent = 'Reply too long for follow-up context. Clear this conversation before continuing.'; }
    } else { reply.note.textContent = 'No response returned.'; el('aiPrompt').value = content; }
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
window.addEventListener('roggy-page', e => { if (e.detail.page === 'ai') { refresh(); startTranscriptPanel(); } });
function authChanged(session) {
  const authorized = isOwnerSession(session);
  if (!authorized) { checking?.abort(); checking = null; clearConversation(); online = false; status('Sign in required', 'offline'); stopTranscriptPanel(); }
  signedIn = authorized; controls(); if (signedIn && !el('aiPage').hidden) refresh();
  if (signedIn && !el('aiPage').hidden) startTranscriptPanel();
}
window.addEventListener('roggy-auth', e => { if (!e.detail.signedIn) authChanged(null); else setTimeout(() => sb.auth.getSession().then(({data}) => authChanged(data.session)).catch(() => authChanged(null)), 0); });
sb.auth.getSession().then(({ data }) => authChanged(data.session)).catch(() => authChanged(null));
controls();
