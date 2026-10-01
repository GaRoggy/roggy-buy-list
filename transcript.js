export const TRANSCRIPT_WINDOW_MS = 5 * 60 * 1000;

function timestampMs(value, fallback) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createTranscriptStore({ now = () => Date.now(), windowMs = TRANSCRIPT_WINDOW_MS, maxEntries = 200 } = {}) {
  const entries = new Map();

  function prune() {
    const cutoff = now() - windowMs;
    for (const [id, entry] of entries) {
      if (timestampMs(entry.timestamp, entry.receivedAt) < cutoff) entries.delete(id);
    }
    while (entries.size > maxEntries) {
      const oldest = [...entries.values()].sort((a, b) => a.receivedAt - b.receivedAt)[0];
      if (!oldest) break;
      entries.delete(oldest.event_id);
    }
  }

  return {
    ingest(raw) {
      if (!raw || typeof raw !== "object") return null;
      const isResponse = raw.type === "layne_voice_response" || raw.event_type === "layne_voice_response";
      const text = String(isResponse ? (raw.message ?? "") : (raw.text ?? raw.transcript ?? "")).trim();
      const microphoneId = String(raw.microphone_id ?? "").trim();
      if (!text || !microphoneId) return null;
      const receivedAt = now();
      const eventId = String(raw.event_id ?? raw.utterance_id ?? `${raw.timestamp ?? receivedAt}:${microphoneId}:${text}`);
      const existing = entries.get(eventId);
      const entry = {
        ...(existing || {}),
        ...raw,
        event_id: eventId,
        microphone_id: microphoneId,
        text,
        kind: isResponse ? "assistant" : "user",
        role: isResponse ? "assistant" : "user",
        timestamp: String(raw.timestamp || existing?.timestamp || new Date(receivedAt).toISOString()),
        receivedAt: existing?.receivedAt ?? receivedAt,
      };
      entries.set(eventId, entry);
      prune();
      return entry;
    },
    list(filter = "all") {
      prune();
      return [...entries.values()]
        .filter(entry => filter === "all" || entry.microphone_id === filter)
        .sort((a, b) => timestampMs(a.timestamp, a.receivedAt) - timestampMs(b.timestamp, b.receivedAt));
    },
    clear() { entries.clear(); },
    size() { prune(); return entries.size; },
  };
}

export function roomLabel(room) {
  return String(room || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, character => character.toUpperCase())
    .trim();
}

export function formatTranscriptTime(value, { timeZone = "America/Chicago" } = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(date);
}

export function formatTranscriptLine(event, options = {}) {
  const time = formatTranscriptTime(event?.timestamp, options);
  if (event?.kind === "assistant" || event?.type === "layne_voice_response" || event?.event_type === "layne_voice_response") {
    return `${time} Layne: "${String(event?.text || event?.message || "")}"`;
  }
  const name = String(event?.friendly_name || roomLabel(event?.room) || event?.microphone_id || "Unknown microphone");
  return `${time} ME · 🎤 ${name}: "${String(event?.text || event?.transcript || "")}"`;
}
