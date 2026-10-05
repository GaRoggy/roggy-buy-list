import { MonitorError } from './core.mjs';

const MAX_REASON = 500;
const MAX_ACTION = 160;
const MAX_PROJECT = 160;

function clip(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) || null : null;
}

// Only the canonical, already-minimized fields cross this boundary. The
// `role` marker is data for the enrichment adapter, not instructions from a
// provider. Callers must keep the returned annotation side-effect free.
export function enrichmentInput(event) {
  return { role: 'untrusted_event_data', event: {
    event_type: event?.event_type || null, title: clip(event?.title, 240),
    summary: clip(event?.summary, 1000), domains: Array.isArray(event?.domains) ? event.domains.slice(0, 8) : [],
    tags: Array.isArray(event?.tags) ? event.tags.slice(0, 16) : [],
    entities: Array.isArray(event?.entities) ? event.entities.slice(0, 16) : [],
    importance: event?.importance ?? null, confidence: event?.confidence ?? null,
  } };
}

export function validateEnrichment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MonitorError('INVALID_ENRICHMENT');
  const adjustment = value.importance_adjustment == null ? 0 : Number(value.importance_adjustment);
  if (!Number.isFinite(adjustment) || adjustment < -1 || adjustment > 1) throw new MonitorError('INVALID_ENRICHMENT');
  if (value.action_required != null && typeof value.action_required !== 'boolean') throw new MonitorError('INVALID_ENRICHMENT');
  if (value.related_project != null && typeof value.related_project !== 'string') throw new MonitorError('INVALID_ENRICHMENT');
  if (value.suggested_action != null && typeof value.suggested_action !== 'string') throw new MonitorError('INVALID_ENRICHMENT');
  return { importance_adjustment: adjustment, reason: clip(value.reason, MAX_REASON),
    action_required: value.action_required ?? null,
    suggested_action: clip(value.suggested_action, MAX_ACTION),
    related_project: clip(value.related_project, MAX_PROJECT) };
}

export async function enrichEvent(event, runner, { timeoutMs = 5000 } = {}) {
  if (typeof runner !== 'function') return null;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new MonitorError('ENRICHMENT_TIMEOUT')), timeoutMs); });
  try {
    const result = await Promise.race([Promise.resolve().then(() => runner(enrichmentInput(event))), timeout]);
    return validateEnrichment(result);
  } finally { clearTimeout(timer); }
}
