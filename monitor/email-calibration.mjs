/* Local, privacy-conscious calibration helpers. These functions accept only
 * bounded metadata and expected labels supplied by a human review process. */

export const CONFIDENCE_BUCKETS = Object.freeze([
  { label: '0.5-0.6', min: 0.5, max: 0.6 },
  { label: '0.6-0.7', min: 0.6, max: 0.7 },
  { label: '0.7-0.8', min: 0.7, max: 0.8 },
  { label: '0.8-0.9', min: 0.8, max: 0.9 },
  { label: '0.9-1.0', min: 0.9, max: 1.000001 },
]);

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function clip(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit) : null; }
function key(value) { return String(value || '').toLowerCase(); }

export function reviewSafeMessage(record = {}) {
  const p = record.payload && typeof record.payload === 'object' ? record.payload : record;
  return {
    id: record.id || record.external_id || p.source_message_id || null,
    source_message_id: clip(p.source_message_id || record.external_id, 200),
    occurred_at: record.occurred_at || p.timestamp || null,
    sender: clip(p.sender, 240), subject: clip(p.subject, 300), summary: clip(p.summary, 500),
    category: clip(p.category, 60), predicted_route: clip(p.route, 30),
    route_confidence: clamp(p.route_confidence), reason: clip(p.reason, 300),
    ambiguity_reason: Array.isArray(p.ambiguity_reason) ? p.ambiguity_reason.slice(0, 8) : [],
  };
}

export function representativeSample(records = [], { limit = 60, now = new Date(), maxAgeDays = 90 } = {}) {
  const nowMs = new Date(now).getTime();
  const bounded = records.filter(Boolean).map(reviewSafeMessage)
    .filter(row => !row.occurred_at || !Number.isFinite(Date.parse(row.occurred_at)) ||
      nowMs - Date.parse(row.occurred_at) <= Math.max(1, maxAgeDays) * 86400000)
    .filter(row => row.id && row.source_message_id)
    .sort((a, b) => {
      const aTime = Date.parse(a.occurred_at || '') || 0, bTime = Date.parse(b.occurred_at || '') || 0;
      return bTime - aTime || String(b.id).localeCompare(String(a.id));
    });
  const groups = new Map();
  for (const row of bounded) {
    const group = `${row.predicted_route || 'unknown'}:${row.category || 'unknown'}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  const result = [];
  while (result.length < limit && groups.size) {
    for (const [group, rows] of groups) {
      const row = rows.shift();
      if (row) result.push({ ...row, sampled_at: new Date(now).toISOString() });
      if (!rows.length) groups.delete(group);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function counts(labels, actual, predicted) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const row of labels) {
    const yesActual = actual(row), yesPredicted = predicted(row);
    if (yesActual && yesPredicted) tp++;
    else if (!yesActual && yesPredicted) fp++;
    else if (yesActual && !yesPredicted) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    smoothed_precision: (tp + 1) / (tp + fp + 2),
    smoothed_recall: (tp + 1) / (tp + fn + 2) };
}

function expectedRow(sample, expected) {
  return expected?.[sample.id] || expected?.[sample.source_message_id] || sample.expected || {};
}

export function evaluateEmailClassifier(samples = [], { classify, expected = {} } = {}) {
  if (typeof classify !== 'function') throw new TypeError('classify must be a function');
  const rows = samples.map(sample => {
    const predicted = classify(sample) || {};
    const exp = expectedRow(sample, expected);
    return { sample, predicted, expected: exp, correct_route: key(predicted.route || predicted.predicted_route) === key(exp.route),
      route_confidence: clamp(predicted.route_confidence ?? predicted.confidence) };
  });
  const routeNames = ['dashboard', 'finance', 'mail', 'hidden'];
  const route_metrics = Object.fromEntries(routeNames.map(route => [route, counts(rows,
    row => key(row.expected.route) === route, row => key(row.predicted.route) === route)]));
  const field_metrics = {};
  for (const field of ['action_required', 'needs_reply', 'finance_related', 'low_value']) {
    field_metrics[field] = counts(rows, row => row.expected[field] === true, row => row.predicted[field] === true);
  }
  const buckets = CONFIDENCE_BUCKETS.map(bucket => {
    const inBucket = rows.filter(row => row.route_confidence >= bucket.min && row.route_confidence < bucket.max);
    return { ...bucket, sample_size: inBucket.length,
      accuracy: inBucket.length ? inBucket.filter(row => row.correct_route).length / inBucket.length : null,
      mean_confidence: inBucket.length ? inBucket.reduce((sum, row) => sum + row.route_confidence, 0) / inBucket.length : null };
  });
  const total = rows.length;
  const brier_score = total ? rows.reduce((sum, row) => sum + (row.route_confidence - (row.correct_route ? 1 : 0)) ** 2, 0) / total : null;
  const expected_calibration_error = total ? buckets.reduce((sum, bucket) => sum + (bucket.sample_size / total) *
    (bucket.accuracy == null ? 0 : Math.abs(bucket.mean_confidence - bucket.accuracy)), 0) : null;
  return { sample_size: total, route_metrics, field_metrics, confidence_buckets: buckets,
    calibration: { brier_score, expected_calibration_error, sufficient_sample: total >= 30 }, rows };
}

export function aggregateFeedback(feedback = [], { halfLifeDays = 45, now = new Date() } = {}) {
  const nowMs = new Date(now).getTime();
  const decay = Math.max(1, Number(halfLifeDays) || 45);
  const byMessage = new Map();
  const byRoute = new Map();
  const byField = new Map();
  for (const item of feedback) {
    const from = key(item.from_route || item.predicted_route), to = key(item.to_route || item.expected_route);
    if (!from || !to || from === to) continue;
    const ageDays = Math.max(0, (nowMs - new Date(item.created_at || now).getTime()) / 86400000);
    const weight = 2 ** (-ageDays / decay);
    const row = { from, to, weight };
    const messageId = item.source_message_id || item.message_id;
    if (messageId) byMessage.set(messageId, [...(byMessage.get(messageId) || []), row]);
    const routeKey = `${from}->${to}`;
    byRoute.set(routeKey, (byRoute.get(routeKey) || 0) + weight);
    for (const field of ['importance', 'action_required', 'needs_reply', 'finance_related', 'low_value']) {
      if (typeof item.label?.[field] !== 'boolean') continue;
      const fieldKey = `${field}:${item.label[field]}`;
      byField.set(fieldKey, (byField.get(fieldKey) || 0) + weight);
    }
  }
  return { by_message: Object.fromEntries(byMessage), route_corrections: Object.fromEntries([...byRoute].map(([k, v]) => [k, Number(v.toFixed(3))])),
    field_corrections: Object.fromEntries([...byField].map(([k, v]) => [k, Number(v.toFixed(3))])),
    sample_size: feedback.length };
}

export function applyFeedbackToRoute(route, feedback = {}, { minimumWeight = 2 } = {}) {
  const corrections = feedback.route_corrections || {};
  const candidates = Object.entries(corrections).filter(([pair, weight]) => pair.startsWith(`${key(route)}->`) && weight >= minimumWeight)
    .sort((a, b) => b[1] - a[1]);
  if (!candidates.length) return { route, feedback_applied: false };
  const next = candidates[0][0].split('->')[1];
  return { route: next, feedback_applied: true, feedback_weight: candidates[0][1] };
}

export function tuneThresholds(evaluator, base = {}, { minRecall = 0.55 } = {}) {
  if (typeof evaluator !== 'function') throw new TypeError('evaluator must be a function');
  let best = null;
  for (const action of [0.68, 0.74, 0.80, 0.86]) for (const reply of [0.70, 0.78, 0.84, 0.90]) {
    const thresholds = { ...base, dashboardActionConfidence: action, dashboardReplyConfidence: reply };
    const result = evaluator(thresholds), metric = result?.route_metrics?.dashboard;
    if (!metric || (metric.recall != null && metric.recall < minRecall)) continue;
    const score = (metric.precision ?? 0) * 0.7 + (metric.recall ?? 0) * 0.3;
    if (!best || score > best.score) best = { thresholds, score, metrics: metric };
  }
  return best || { thresholds: { ...base }, score: null, metrics: null, insufficient_data: true };
}
