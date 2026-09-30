import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFeedback, evaluateEmailClassifier, representativeSample, tuneThresholds } from '../email-calibration.mjs';

const rows = [
  { external_id: '1', payload: { source_message_id: '1', sender: 'A', subject: 'Bill due', summary: 'Due tomorrow', category: 'bills', route: 'dashboard', route_confidence: 0.86 } },
  { external_id: '2', payload: { source_message_id: '2', sender: 'B', subject: 'Receipt', summary: 'Paid', category: 'receipts', route: 'finance', route_confidence: 0.9 } },
  { external_id: '3', payload: { source_message_id: '3', sender: 'C', subject: 'Sale', summary: 'Discount', category: 'promotions', route: 'hidden', route_confidence: 0.95 } },
  { external_id: '4', payload: { source_message_id: '4', sender: 'D', subject: 'Question', summary: 'Can you reply?', category: 'personal', route: 'dashboard', route_confidence: 0.8 } },
];

test('representative sampling is bounded, stratified, and excludes raw body fields', () => {
  const sample = representativeSample(rows, { limit: 3, now: '2026-09-30T12:00:00Z' });
  assert.equal(sample.length, 3);
  assert.equal(sample[0].raw_body, undefined);
  assert.equal(sample[0].sampled_at, '2026-09-30T12:00:00.000Z');
});

test('calibration reports route and field precision/recall plus confidence buckets', () => {
  const result = evaluateEmailClassifier(rows.map(r => ({ ...r.payload, id: r.external_id })), {
    expected: { '1': { route: 'dashboard', action_required: true }, '2': { route: 'finance', action_required: false },
      '3': { route: 'hidden', action_required: false }, '4': { route: 'mail', action_required: true } },
    classify: sample => ({ route: sample.route, route_confidence: sample.route_confidence, action_required: sample.category === 'bills' || sample.category === 'personal' }),
  });
  assert.equal(result.sample_size, 4);
  assert.equal(result.route_metrics.dashboard.tp, 1);
  assert.equal(result.field_metrics.action_required.precision, 1);
  assert.equal(result.calibration.brier_score >= 0, true);
  assert.equal(result.confidence_buckets.length, 5);
});

test('feedback accumulates weighted corrections instead of becoming a universal override', () => {
  const result = aggregateFeedback([
    { source_message_id: 'm1', from_route: 'mail', to_route: 'dashboard', label: { needs_reply: true }, created_at: '2026-09-29T12:00:00Z' },
    { source_message_id: 'm2', from_route: 'mail', to_route: 'dashboard', created_at: '2026-09-30T11:00:00Z' },
  ], { now: '2026-09-30T12:00:00Z' });
  assert.equal(result.sample_size, 2);
  assert.equal(result.route_corrections['mail->dashboard'] > 1, true);
  assert.equal(result.field_corrections['needs_reply:true'] > 0, true);
  assert.equal(result.by_message.m1.length, 1);
});

test('threshold tuning honors recall floor and remains configurable', () => {
  const result = tuneThresholds(thresholds => ({ route_metrics: { dashboard: { precision: thresholds.dashboardActionConfidence > 0.75 ? 0.9 : 0.7, recall: 0.6 } } }), {}, { minRecall: 0.55 });
  assert.equal(result.thresholds.dashboardActionConfidence > 0.75, true);
  assert.equal(result.insufficient_data, undefined);
});
