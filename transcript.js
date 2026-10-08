export const TRANSCRIPT_WINDOW_MS = 5 * 60 * 1000;
export const TRANSCRIPT_DEDUPE_WINDOW_MS = 3 * 1000;

function timestampMs(value, fallback) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isResponseEvent(raw) {
  return raw?.type === "layne_voice_response" || raw?.event_type === "layne_voice_response";
}

function eventText(raw, response) {
  return String(response ? (raw.message ?? raw.text ?? "") : (raw.original_transcript ?? raw.transcript ?? raw.text ?? raw.canonical_text ?? raw.normalized_transcript ?? "")).trim();
}

function comparisonText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^\s*(?:(?:hey|okay|ok|hi)\s+)?(?:layne|lane)\b[\s,.:!?-]*/i, "")
    .replace(/\blane\b/gi, "layne")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function displayText(value) {
  // The panel is an ASR diagnostic. Preserve exactly what the recognizer
  // produced; canonical wake normalization remains available in the raw
  // event fields and must not be presented as invented speech.
  return String(value || "").trim();
}

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = left.split(" "), b = right.split(" ");
  const aSet = new Set(a), bSet = new Set(b);
  const intersection = [...aSet].filter(token => bSet.has(token)).length;
  const union = new Set([...aSet, ...bSet]).size;
  const jaccard = union ? intersection / union : 0;
  const matrix = Array.from({ length: a.length + 1 }, (_, row) => {
    const values = Array(b.length + 1).fill(0);
    values[0] = row;
    return values;
  });
  for (let column = 0; column <= b.length; column++) matrix[0][column] = column;
  for (let row = 1; row <= a.length; row++) {
    for (let column = 1; column <= b.length; column++) {
      matrix[row][column] = a[row - 1] === b[column - 1]
        ? matrix[row - 1][column - 1]
        : 1 + Math.min(matrix[row - 1][column], matrix[row][column - 1], matrix[row - 1][column - 1]);
    }
  }
  const distance = matrix[a.length][b.length];
  const editRatio = 1 - distance / Math.max(left.length, right.length);
  return Math.min(editRatio, 0.5 + 0.5 * jaccard);
}

function unique(values) {
  return [...new Set(values.filter(value => String(value || "").trim()).map(value => String(value).trim()))];
}

function microphoneIds(raw) {
  return unique([
    raw?.microphone_id,
    ...(Array.isArray(raw?.microphone_ids) ? raw.microphone_ids : []),
  ]);
}

function logicalId(raw, response) {
  if (response) {
    const responseIdentity = raw?.response_id || raw?.event_id || raw?.transcript_event_id;
    return responseIdentity ? `response:${String(responseIdentity).trim()}` : "";
  }
  const explicit = [raw?.logical_utterance_id, raw?.utterance_group_id].find(value => String(value || "").trim());
  if (explicit) return String(explicit).trim();
  return "";
}

function rawEventId(raw, receivedAt, text, microphones) {
  return String(raw?.event_id ?? raw?.utterance_id ?? `${raw?.timestamp ?? receivedAt}:${microphones[0] || "voice"}:${text}`);
}

export function createTranscriptStore({ now = () => Date.now(), windowMs = TRANSCRIPT_WINDOW_MS, maxEntries = 200 } = {}) {
  const entries = new Map();
  const rawToGroup = new Map();
  const logicalToGroup = new Map();

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
    for (const [rawId, groupId] of rawToGroup) if (!entries.has(groupId)) rawToGroup.delete(rawId);
    for (const [id, groupId] of logicalToGroup) if (!entries.has(groupId)) logicalToGroup.delete(id);
  }

  function findFallbackGroup(kind, normalized, eventTime, incomingMicrophones) {
    if (!normalized || !incomingMicrophones.length) return "";
    for (const entry of entries.values()) {
      if (entry.kind !== kind) continue;
      const existingMicrophones = unique(entry.microphone_ids || [entry.microphone_id]);
      const differentMicrophone = kind === "user"
        ? existingMicrophones.some(id => !incomingMicrophones.includes(id))
        : existingMicrophones.length === 0 || existingMicrophones.some(id => !incomingMicrophones.includes(id));
      if (!differentMicrophone) continue;
      const existingTime = timestampMs(entry.timestamp, entry.receivedAt);
      if (Math.abs(existingTime - eventTime) > TRANSCRIPT_DEDUPE_WINDOW_MS) continue;
      if (similarity(comparisonText(entry.text), normalized) >= 0.86) return entry.event_id;
    }
    return "";
  }

  function mergeEntry(existing, raw, groupId, rawId, response, receivedAt, text, microphones, relatedMicrophones) {
    const eventTime = timestampMs(raw.timestamp, receivedAt);
    const oldTime = existing ? timestampMs(existing.timestamp, existing.receivedAt) : eventTime;
    const allMicrophones = unique([...(existing?.microphone_ids || []), ...microphones]);
    const allRelatedMicrophones = unique([...(existing?.related_microphone_ids || []), ...relatedMicrophones, ...allMicrophones]);
    const rawEventIds = unique([...(existing?.raw_event_ids || []), existing?.raw_event_id, rawId]);
    const normalized = String(raw.normalized_transcript || "").trim();
      const sourceText = response
        ? (String(raw.message || raw.text || "").trim() || existing?.text || text)
        : String(raw.original_transcript || raw.transcript || raw.text || raw.canonical_text || normalized || text || existing?.text || "").trim();
    return {
      ...(existing || {}),
      ...raw,
      event_id: groupId,
      raw_event_id: existing?.raw_event_id || rawId,
      raw_event_ids: rawEventIds,
      raw_event_count: rawEventIds.length,
      microphone_id: existing?.microphone_id || microphones[0] || "",
      microphone_ids: allMicrophones,
      related_microphone_ids: allRelatedMicrophones,
      kind: response ? "assistant" : "user",
      role: response ? "assistant" : "user",
      text: sourceText,
      original_transcript: existing?.original_transcript || raw.original_transcript || raw.transcript || text,
      normalized_transcript: normalized || existing?.normalized_transcript || text,
      timestamp: new Date(Math.min(oldTime, eventTime)).toISOString(),
      receivedAt: existing?.receivedAt ?? receivedAt,
      also_heard_by: unique([...(existing?.also_heard_by || []), ...(Array.isArray(raw.also_heard_by) ? raw.also_heard_by : [])]),
    };
  }

  return {
    ingest(raw) {
      if (!raw || typeof raw !== "object") return null;
      const response = isResponseEvent(raw);
      // The bridge commits the canonical user event before routing.  This is
      // a bounded UI-side repair for a transient history-ingest failure: the
      // response carries the same canonical object, so an executed action can
      // never appear without the user turn that caused it.  Normal delivery
      // finds the existing user group and does not create a duplicate.
      if (response && raw.canonical_text && raw.transcript_event_id
          && !rawToGroup.has(String(raw.transcript_event_id).trim())) {
        this.ingest({
          ...raw,
          type: "whisper_transcript",
          event_type: "whisper_transcript",
          event_id: raw.transcript_event_id,
          response_id: undefined,
          timestamp: raw.speech_timestamp || raw.timestamp,
          text: raw.canonical_text,
          transcript: raw.canonical_text,
          normalized_transcript: raw.canonical_text,
          original_transcript: raw.canonical_text,
          canonical_utterance: true,
          addressing_classification: raw.addressing_classification || "addressed_to_layne",
          final: true,
        });
      }
      if (!response && raw.final === false) return null;
      const text = eventText(raw, response);
      const microphones = microphoneIds(raw);
      if (!text) return null;
      const receivedAt = now();
      const rawId = rawEventId(raw, receivedAt, text, microphones);
      const eventTime = timestampMs(raw.timestamp, receivedAt);
      const explicitLogicalId = logicalId(raw, response);
      const relatedGroup = response && raw.transcript_event_id ? rawToGroup.get(String(raw.transcript_event_id).trim()) : "";
      const duplicateGroup = raw.duplicate_of ? rawToGroup.get(String(raw.duplicate_of).trim()) : "";
      const knownLogicalGroup = explicitLogicalId ? logicalToGroup.get(explicitLogicalId) : "";
      let groupId = knownLogicalGroup || (explicitLogicalId
        ? (response ? `response:${explicitLogicalId}` : `logical:${explicitLogicalId}`)
        : (duplicateGroup || (response ? `response:${rawId}` : rawId)));
      if (!entries.has(groupId)) {
        const fallback = findFallbackGroup(response ? "assistant" : "user", comparisonText(text), eventTime, microphones);
        if (fallback) groupId = fallback;
      }
      const existing = entries.get(groupId);
      const relatedEntry = relatedGroup ? entries.get(relatedGroup) : null;
      const relatedMicrophones = response ? (relatedEntry?.microphone_ids || relatedEntry?.related_microphone_ids || []) : microphones;
      const entry = mergeEntry(existing, raw, groupId, rawId, response, receivedAt, text, microphones, relatedMicrophones);
      entries.set(groupId, entry);
      rawToGroup.set(rawId, groupId);
      if (explicitLogicalId) logicalToGroup.set(explicitLogicalId, groupId);
      if (raw.transcript_event_id) rawToGroup.set(String(raw.transcript_event_id).trim(), groupId);
      prune();
      return entry;
    },
    list(filter = "all") {
      prune();
      return [...entries.values()]
        .filter(entry => filter === "all" || (entry.kind === "assistant"
          ? unique(entry.related_microphone_ids || entry.microphone_ids).includes(filter)
          : unique(entry.microphone_ids || [entry.microphone_id]).includes(filter)))
        .sort((a, b) => {
          const timeDelta = timestampMs(a.timestamp, a.receivedAt) - timestampMs(b.timestamp, b.receivedAt);
          if (timeDelta) return timeDelta;
          // If two events share a timestamp, preserve causal turn order.
          return (a.kind === "assistant" ? 1 : 0) - (b.kind === "assistant" ? 1 : 0);
        });
    },
    clear() { entries.clear(); rawToGroup.clear(); logicalToGroup.clear(); },
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
  const response = event?.kind === "assistant" || isResponseEvent(event);
  const text = displayText(response ? (event?.text || event?.message) : (event?.original_transcript || event?.transcript || event?.text));
  const source = response ? "Layne" : (event?.friendly_name || roomLabel(event?.room) || event?.microphone_id || "Microphone");
  const label = response ? (String(event?.status || "").toLowerCase() === "failed" ? "Failure" : "Response")
    : (event?.layne_activated || event?.addressing_classification === "addressed_to_layne" ? "Command" : "Ambient");
  const confidence = event?.confidence ?? event?.microphone_confidence ?? event?.speech_validity?.score;
  const confidenceText = Number.isFinite(Number(confidence)) ? ` · confidence ${Number(confidence).toFixed(2)}` : "";
  const uncertainty = event?.transcription_status === "uncertain" || (Array.isArray(event?.uncertainty) && event.uncertainty.length)
    ? " · uncertain" : "";
  return `${time} · ${source} · ${response ? "Layne" : "Heard"}: "${text}" · ${label}${confidenceText}${uncertainty}`;
}
