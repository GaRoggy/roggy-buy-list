export const TRANSCRIPT_WINDOW_MS = 5 * 60 * 1000;
const VOICE_DEDUPE_WINDOW_MS = 1800;

function timestampMs(value, fallback) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedVoiceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\blane\b/g, "layne")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:hey\s+|okay\s+|ok\s+)?layne\s+/, "");
}

function similarVoiceText(a, b) {
  const left = normalizedVoiceText(a), right = normalizedVoiceText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const A = new Set(left.split(" ")), B = new Set(right.split(" "));
  let common = 0;
  for (const token of A) if (B.has(token)) common++;
  const union = new Set([...A, ...B]).size || 1;
  return common / union >= 0.72;
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

  function findDuplicate(raw, text, receivedAt) {
    const logicalId = String(raw.logical_utterance_id || raw.utterance_group_id || raw.duplicate_of || "").trim();
    const stamp = timestampMs(raw.timestamp, receivedAt);
    for (const entry of entries.values()) {
      if (entry.role === "assistant") continue;
      if (logicalId && logicalId === entry.logical_utterance_id) return entry;
      const otherStamp = timestampMs(entry.timestamp, entry.receivedAt);
      if (Math.abs(stamp - otherStamp) > VOICE_DEDUPE_WINDOW_MS) continue;
      if (similarVoiceText(text, entry.text)) return entry;
    }
    return null;
  }

  return {
    ingest(raw) {
      if (!raw || typeof raw !== "object") return null;
      const isResponse = raw.type === "layne_voice_response" || raw.role === "assistant";
      const text = String(
        isResponse
          ? (raw.message ?? raw.response ?? raw.text ?? "")
          : (raw.normalized_transcript ?? raw.text ?? raw.transcript ?? raw.chat_text ?? "")
      ).trim();
      if (!text) return null;

      const receivedAt = now();
      const microphoneId = String(raw.microphone_id ?? "").trim();
      const role = isResponse ? "assistant" : "user";
      const logicalId = String(raw.logical_utterance_id || raw.utterance_group_id || raw.duplicate_of || "").trim();

      if (!isResponse) {
        const duplicate = findDuplicate(raw, text, receivedAt);
        if (duplicate) {
          duplicate.also_heard_by ||= [];
          if (microphoneId && microphoneId !== duplicate.microphone_id && !duplicate.also_heard_by.includes(microphoneId)) {
            duplicate.also_heard_by.push(microphoneId);
          }
          duplicate.receivedAt = Math.min(duplicate.receivedAt, receivedAt);
          prune();
          return duplicate;
        }
      }

      const eventId = String(
        raw.event_id ??
        raw.transcript_event_id ??
        raw.utterance_id ??
        `${raw.timestamp ?? receivedAt}:${role}:${microphoneId || "layne"}:${text}`
      );
      const existing = entries.get(eventId);
      const entry = {
        ...(existing || {}),
        ...raw,
        event_id: eventId,
        role,
        microphone_id: microphoneId,
        logical_utterance_id: logicalId,
        text,
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
        .filter(entry => entry.role === "assistant" || filter === "all" || entry.microphone_id === filter)
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
  const speaker = event?.role === "assistant" ? "Layne" : "Me";
  return `${time} ${speaker}: "${String(event?.text || "")}"`;
}
