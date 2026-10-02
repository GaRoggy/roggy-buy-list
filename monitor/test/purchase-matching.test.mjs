import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPurchaseData, generatePurchaseMatches, matchPurchaseProduct, productFingerprint,
} from '../purchase-matching.mjs';

const candidate = (id, item, bought_at) => ({ id, item, list_type: 'buy', status: 'bought', bought_at });
const amazonOrder = (body, timestamp = '2026-09-29T12:00:00Z') => extractPurchaseData({
  subject: 'Amazon order confirmation', body, sender: 'Amazon <orders@amazon.com>', timestamp,
});

test('A: deterministic brand/category/name evidence produces a high-confidence match', () => {
  const purchase = amazonOrder('1. DEWALT FlexTorq Drill/Driver Bit Set USD 34.99');
  const result = generatePurchaseMatches({ purchase, candidates: [candidate('drill', 'DeWalt drill bit kit', '2026-09-29T10:00:00Z')], receivedAt: purchase.purchase_date });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].match_status, 'auto');
  assert.ok(result.matches[0].confidence >= 0.90);
});

test('B: one order line can create independent relationships to three Bought items', () => {
  const purchase = amazonOrder([
    '1. DEWALT FlexTorq Drill/Driver Bit Set USD 34.99',
    '2. Hefty Small Trash Bags USD 10.99',
    '3. Toaster USD 46.56',
  ].join('\n'));
  const result = generatePurchaseMatches({ purchase, candidates: [
    candidate('drill', 'DeWalt drill bit kit', '2026-09-29T10:00:00Z'),
    candidate('bags', 'small can trash bags', '2026-09-29T10:00:00Z'),
    candidate('toaster', 'toaster', '2026-09-29T10:00:00Z'),
  ], receivedAt: purchase.purchase_date });
  assert.deepEqual(result.matches.map(row => row.buy_item_id).sort(), ['bags', 'drill', 'toaster']);
  assert.equal(new Set(result.matches.map(row => row.product_fingerprint)).size, 3);
});

test('C: later lifecycle messages reuse an established relationship without product text', () => {
  const purchase = { purchase_related: true, email_type: 'shipping_confirmation', tracking_number: '1Z9999999999999999', products: [] };
  const history = [{ buy_item_id: 'drill' }];
  const result = generatePurchaseMatches({ purchase, history, candidates: [candidate('drill', 'DeWalt drill bit kit', '2026-09-29T10:00:00Z')] });
  assert.deepEqual(result.matches.map(row => row.buy_item_id), ['drill']);
  assert.equal(result.matches[0].match_status, 'auto');
  assert.equal(result.matches[0].confidence, 0.99);
});

test('D: category conflict prevents trash bags from matching dog waste bags automatically', () => {
  const result = matchPurchaseProduct({ product_name: 'Amazon Basics Dog Waste Bags' }, { id: 'trash', item: 'trash bags', bought_at: '2026-09-29T10:00:00Z' }, { receivedAt: '2026-09-29T12:00:00Z' });
  assert.ok(result.confidence < 0.70);
  assert.equal(result.match_status, null);
  assert.ok(result.evidence.some(value => value.includes('category conflict')));
});

test('E: the same extracted product has a stable idempotency fingerprint', () => {
  const purchase = amazonOrder('1. DEWALT FlexTorq Drill/Driver Bit Set USD 34.99');
  const first = productFingerprint(purchase.products[0], 0);
  const second = productFingerprint({ ...purchase.products[0] }, 0);
  assert.equal(first, second);
});

test('F: unmatched bundled products are left unmatched while known lines still match', () => {
  const purchase = amazonOrder([
    '1. DEWALT FlexTorq Drill/Driver Bit Set USD 34.99',
    '2. Mystery Widget USD 10.99',
    '3. Toaster USD 46.56',
  ].join('\n'));
  const result = generatePurchaseMatches({ purchase, candidates: [
    candidate('drill', 'DeWalt drill bit kit', '2026-09-29T10:00:00Z'),
    candidate('toaster', 'toaster', '2026-09-29T10:00:00Z'),
  ], receivedAt: purchase.purchase_date });
  assert.deepEqual(result.matches.map(row => row.buy_item_id).sort(), ['drill', 'toaster']);
  assert.ok(result.rejected.some(row => row.product_name === 'Mystery Widget'));
});

test('G: timing selects the recent duplicate item instead of linking both', () => {
  const purchase = amazonOrder('HDMI cable USD 12.99', '2026-09-29T12:00:00Z');
  const result = generatePurchaseMatches({ purchase, candidates: [
    candidate('old', 'HDMI cable', '2026-09-01T12:00:00Z'),
    candidate('recent', 'HDMI cable', '2026-09-29T10:00:00Z'),
  ], receivedAt: purchase.purchase_date });
  assert.deepEqual(result.matches.map(row => row.buy_item_id), ['recent']);
  assert.ok(result.rejected.some(row => row.candidate_id === 'old'));
});

