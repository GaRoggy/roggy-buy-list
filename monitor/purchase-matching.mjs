import { createHash } from 'node:crypto';

export const PURCHASE_MATCHING_VERSION = 'purchase-matching-v1';
export const PURCHASE_MATCHING_CONFIG = Object.freeze({
  boughtWindowDays: 90,
  autoThreshold: 0.90,
  suggestionThreshold: 0.70,
  maxCandidates: 1000,
});

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'item', 'of', 'on',
  'order', 'the', 'to', 'with', 'your', 'our', 'this', 'that', 'new',
]);
const BRAND_WORDS = new Set([
  'amazon', 'dewalt', 'hefty', 'glad', 'rubbermaid', 'tupperware', 'keurig',
  'kitchenaid', 'apple', 'samsung', 'anker', 'belkin', 'oxo', 'stanley',
]);
const CATEGORY_GROUPS = [
  ['drill', 'driver', 'bit', 'bits', 'flextorq', 'impact'],
  ['trash', 'garbage', 'kitchen', 'forceflex', 'can', 'cans', 'hefty', 'glad'],
  ['dog', 'puppy', 'waste', 'poop', 'pet'],
  ['container', 'containers', 'food', 'storage', 'tupperware', 'rubbermaid'],
  ['toaster', 'toast'],
  ['cable', 'cord', 'hdmi', 'usb', 'lightning'],
  ['curtain', 'curtains', 'drape', 'drapes'],
];
const CATEGORY_CONFLICTS = [['trash', 'dog'], ['kitchen', 'dog'], ['food', 'dog'], ['storage', 'dog']];
const EXCLUDED_PRODUCT_LINE = /^(?:order|grand|subtotal|tax|shipping|delivery|discount|promotion|total|payment|billing|address|estimated|arrives?|quantity|qty|tracking|return|refund|invoice|receipt)\b/i;
const PURCHASE_LANGUAGE = /\b(?:order|ordered|purchase|purchased|receipt|invoice|shipped|shipping|delivery|delivered|tracking|pickup|backordered|cancelled|canceled|refund|return|payment confirmation|order number)\b/i;
const DATE_PATTERN = /\b(20\d{2}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/20\d{2})\b/g;
const MONEY_PATTERN = /(?:(USD|EUR|GBP|CAD|AUD)\s*)?\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})\b/i;
const IDENTIFIER_PATTERN = /\b[A-Z]{1,8}[-/]?\d{2,}[A-Z0-9-]*\b/g;

function clip(value, limit = 240) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function bounded(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }

export function normalizeProductName(value) {
  return clip(value, 300).toLowerCase().replace(/[×]/g, 'x')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(value) {
  return new Set(normalizeProductName(value).split(' ').filter(token => token && !STOP_WORDS.has(token)));
}

function categoryHits(value) {
  const set = tokens(value);
  return CATEGORY_GROUPS.map(group => ({
    name: group[0],
    hits: group.filter(token => set.has(token)),
  })).filter(group => group.hits.length);
}

function categoryConflict(left, right) {
  const a = new Set(categoryHits(left).map(group => group.name));
  const b = new Set(categoryHits(right).map(group => group.name));
  return CATEGORY_CONFLICTS.some(([x, y]) => (a.has(x) && b.has(y)) || (a.has(y) && b.has(x)));
}

function productCategory(value) {
  return categoryHits(value).sort((a, b) => b.hits.length - a.hits.length)[0]?.name || null;
}

function identifiers(value) {
  const text = clip(value, 500);
  const explicit = [...text.matchAll(/\b(?:model|sku|part|item)\s*(?:number|#|no\.?)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,})\b/ig)].map(match => match[1].toLowerCase());
  const generic = [...text.matchAll(IDENTIFIER_PATTERN)].map(match => match[0].toLowerCase());
  return [...new Set([...explicit, ...generic])];
}

function parseMoney(value) {
  const match = clip(value, 400).match(MONEY_PATTERN);
  if (!match) return null;
  return { amount: Number(match[2].replaceAll(',', '')), currency: (match[1] || 'USD').toUpperCase() };
}

function senderMerchant(sender) {
  const value = clip(sender, 240);
  const display = value.match(/^\s*["']?([^<"']+?)["']?\s*</)?.[1]?.trim();
  if (display && !/@/.test(display)) return display.slice(0, 120);
  const address = value.match(/@([a-z0-9.-]+)/i)?.[1] || '';
  const parts = address.split('.').filter(Boolean);
  return (parts.length > 1 ? parts.at(-2) : parts[0] || null)?.slice(0, 120) || null;
}

function productLine(line, lineIndex) {
  let value = clip(line, 320).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '');
  if (!value || EXCLUDED_PRODUCT_LINE.test(value)) return null;
  const quantityMatch = value.match(/^(?:(\d+)\s*[x×]\s+|(?:qty|quantity)\s*[:#]?\s*(\d+)\s+)(.+)$/i);
  const quantity = Number(quantityMatch?.[1] || quantityMatch?.[2] || 1);
  if (quantityMatch) value = quantityMatch[3];
  const money = parseMoney(value);
  if (!money) return null;
  value = value.replace(MONEY_PATTERN, '').replace(/\s*[-–—:|]\s*$/, '').trim();
  value = value.replace(/^(?:item|product)\s*[:#-]?\s*/i, '').trim();
  if (value.length < 3 || value.length > 220 || !/[a-z]/i.test(value)) return null;
  if (EXCLUDED_PRODUCT_LINE.test(value)) return null;
  return { product_name: value, quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(999, quantity) : 1,
    price: money.amount, currency: money.currency, line_index: lineIndex };
}

function extractProducts(subject, body) {
  const lines = `${subject}\n${body}`.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const products = [];
  for (let index = 0; index < lines.length; index++) {
    const product = productLine(lines[index], index);
    if (product) products.push(product);
  }
  const seen = new Set();
  return products.filter(product => {
    const key = `${normalizeProductName(product.product_name)}|${product.price ?? ''}|${product.quantity}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 50);
}

function emailType(text) {
  const rules = [
    ['out_for_delivery', /\bout for delivery\b/i], ['delivered', /\b(?:delivered|delivery complete)\b/i],
    ['pickup_ready', /\b(?:ready for pickup|pickup ready|pick-up ready)\b/i],
    ['shipping_confirmation', /\b(?:shipped|shipping confirmation|on the way|tracking number)\b/i],
    ['delayed', /\b(?:delayed|delay|running late)\b/i], ['backordered', /\b(?:backordered|back order|back-order)\b/i],
    ['cancelled', /\b(?:order|purchase|shipment).{0,20}\b(?:cancelled|canceled)\b/i],
    ['refund', /\b(?:refund(?:ed)?|money back)\b/i], ['return_started', /\b(?:return started|return requested|return label)\b/i],
    ['returned', /\b(?:return received|item returned|returned to)\b/i],
    ['payment_confirmation', /\b(?:payment confirmation|payment received|payment processed)\b/i],
    ['receipt', /\b(?:receipt|invoice)\b/i],
    ['order_confirmation', /\b(?:order confirmation|order placed|thanks for your order|purchase confirmation|order number)\b/i],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

export function extractPurchaseData({ subject = '', body = '', sender = '', timestamp = null, category = '', monetary_amount = null } = {}) {
  const safeSubject = clip(subject, 500), safeBody = clip(body, 65536), text = `${safeSubject}\n${safeBody}`;
  const type = emailType(text);
  const purchaseRelated = Boolean(type || (['orders', 'receipts', 'shipping', 'payments'].includes(category) && PURCHASE_LANGUAGE.test(text)));
  const orderNumber = text.match(/\border\s*(?:number|id|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,50})\b/i)?.[1] || null;
  const tracking = text.match(/\btracking\s*(?:number|id|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{7,50})\b/i)?.[1] || null;
  const carrier = text.match(/\b(?:carrier|shipped\s+with|via)\s*[:#-]?\s*([A-Za-z][A-Za-z .&-]{2,50})/i)?.[1]?.trim() || null;
  const orderTotalMatch = text.match(/\b(?:order\s+total|grand\s+total|total)\s*[:#-]?\s*((?:USD|EUR|GBP|CAD|AUD)\s*)?\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})\b/i);
  const orderTotal = orderTotalMatch ? { amount: Number(orderTotalMatch[2].replaceAll(',', '')), currency: (orderTotalMatch[1] || 'USD').trim().toUpperCase() } : null;
  const dateMatches = [...text.matchAll(DATE_PATTERN)].map(match => match[1]);
  const estimated = text.match(/\b(?:estimated delivery|arrives?|delivery)\s*(?:on|by|:)?\s*(20\d{2}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/20\d{2})/i)?.[1] || null;
  const products = extractProducts(safeSubject, safeBody);
  return {
    purchase_related: purchaseRelated,
    merchant: senderMerchant(sender),
    order_number: orderNumber,
    email_type: type,
    order_total: orderTotal || (monetary_amount ? { amount: numberOrNull(monetary_amount.amount), currency: monetary_amount.currency || null } : null),
    purchase_date: dateMatches[0] || (timestamp ? new Date(timestamp).toISOString() : null),
    estimated_delivery_date: estimated,
    tracking_number: tracking,
    carrier,
    order_status: type || null,
    products,
    extraction_version: PURCHASE_MATCHING_VERSION,
  };
}

export function productFingerprint(product = {}, index = 0) {
  const value = [product.normalized_product_name || normalizeProductName(product.product_name), product.model_number || '', product.sku || '', product.line_index ?? index].join('|');
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 40);
}

function itemQuantity(item) {
  const raw = item?.quantity;
  const match = String(raw ?? '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function dateDistanceDays(a, b) {
  const first = Date.parse(a || ''), second = Date.parse(b || '');
  return Number.isFinite(first) && Number.isFinite(second) ? Math.abs(first - second) / 86400000 : null;
}

export function matchPurchaseProduct(product, item, { receivedAt = null, config = PURCHASE_MATCHING_CONFIG, priorLink = false } = {}) {
  const leftName = normalizeProductName(product?.product_name || product?.normalized_product_name || '');
  const rightName = normalizeProductName(item?.item || '');
  if (!leftName || !rightName) return null;
  const left = tokens(leftName), right = tokens(rightName);
  const overlap = [...left].filter(token => right.has(token));
  const overlapRatio = overlap.length / Math.max(1, Math.min(left.size, right.size));
  const jaccard = overlap.length / Math.max(1, new Set([...left, ...right]).size);
  const conflict = categoryConflict(leftName, rightName);
  const leftCategory = productCategory(leftName), rightCategory = productCategory(rightName);
  const leftIds = new Set([...(product.model_number ? [String(product.model_number).toLowerCase()] : []), ...(product.sku ? [String(product.sku).toLowerCase()] : []), ...identifiers(leftName)]);
  const rightIds = new Set(identifiers(rightName));
  const exactIdentifier = [...leftIds].some(value => rightIds.has(value));
  const brands = overlap.filter(token => BRAND_WORDS.has(token));
  const categoryCompatible = Boolean(leftCategory && rightCategory && leftCategory === rightCategory);
  const sameMerchant = Boolean(product.merchant && item.merchant && normalizeProductName(product.merchant) === normalizeProductName(item.merchant));
  const itemPrice = numberOrNull(item.price ?? item.target_price);
  const productPrice = numberOrNull(product.price);
  const priceCompatible = productPrice != null && itemPrice != null && Math.abs(productPrice - itemPrice) <= Math.max(3, productPrice * 0.25);
  const itemQty = itemQuantity(item), productQty = numberOrNull(product.quantity);
  const quantityCompatible = itemQty != null && productQty != null && (itemQty === productQty || Math.abs(itemQty - productQty) <= 1);
  const timing = dateDistanceDays(receivedAt, item.bought_at || item.updated_at || item.deleted_at || item.created_at);
  const timingCompatible = timing != null && timing <= 7;
  const evidence = [];
  let score = 0;
  if (exactIdentifier) { score += 0.55; evidence.push('exact model/SKU identifier'); }
  if (overlapRatio >= 0.75) { score += 0.55; evidence.push('strong product-name overlap'); }
  else if (overlapRatio >= 0.5) { score += 0.38; evidence.push('substantial product-name overlap'); }
  else if (overlapRatio >= 0.34) { score += 0.22; evidence.push('partial product-name overlap'); }
  if (jaccard >= 0.55) score += 0.12;
  if (categoryCompatible) { score += 0.18; evidence.push(`product category compatible: ${leftCategory}`); }
  if (brands.length) { score += 0.12; evidence.push(`brand match: ${brands.slice(0, 2).join(', ')}`); }
  if (sameMerchant) { score += 0.05; evidence.push('merchant consistent'); }
  if (priceCompatible) { score += 0.08; evidence.push('price compatible'); }
  if (quantityCompatible) { score += 0.04; evidence.push('quantity compatible'); }
  if (timingCompatible) { score += timing <= 2 ? 0.10 : 0.05; evidence.push(`Bought date within ${Math.round(timing * 10) / 10} days of email`); }
  if (priorLink) { score += 0.55; evidence.push('existing order/thread/tracking relationship'); }
  if (conflict) { score -= 0.38; evidence.push('category conflict reduces confidence'); }
  if (!evidence.length) evidence.push('insufficient deterministic evidence');
  const confidence = Number(bounded(score).toFixed(3));
  const status = confidence >= config.autoThreshold ? 'auto' : confidence >= config.suggestionThreshold ? 'suggested' : null;
  return { confidence, match_status: status, evidence: evidence.slice(0, 8), signals: {
    overlap_ratio: Number(overlapRatio.toFixed(3)), jaccard: Number(jaccard.toFixed(3)), exact_identifier: exactIdentifier,
    category: leftCategory, category_compatible: categoryCompatible, category_conflict: conflict,
    merchant_match: sameMerchant, price_compatible: priceCompatible, quantity_compatible: quantityCompatible,
    timing_days: timing == null ? null : Number(timing.toFixed(2)), prior_link: priorLink,
  } };
}

export function generatePurchaseMatches({ purchase, candidates = [], history = [], receivedAt = null, config = PURCHASE_MATCHING_CONFIG } = {}) {
  if (!purchase?.purchase_related) return { matches: [], rejected: [], candidate_count: candidates.length };
  const priorIds = new Map((history || []).map(row => [String(row.buy_item_id), row]));
  const matches = [], rejected = [];
  const products = Array.isArray(purchase.products) ? purchase.products : [];
  if (!products.length && priorIds.size) {
    const product = { product_name: purchase.subject || purchase.email_type || 'order lifecycle', line_index: 0 };
    const fingerprint = productFingerprint(product, 0);
    for (const [buyItemId] of priorIds) matches.push({ buy_item_id: buyItemId, product_index: 0,
      product_fingerprint: fingerprint, confidence: 0.99, match_status: 'auto', product_name: product.product_name,
      match_reason: { evidence: ['existing order/thread/tracking relationship'], signals: { prior_link: true }, version: PURCHASE_MATCHING_VERSION } });
    return { matches, rejected, candidate_count: candidates.length };
  }
  const productRows = products.length ? products : [{ product_name: purchase.subject || purchase.email_type || '', line_index: 0 }];
  for (let index = 0; index < productRows.length; index++) {
    const product = { ...productRows[index], merchant: purchase.merchant, normalized_product_name: normalizeProductName(productRows[index].product_name) };
    const ranked = candidates.map(item => ({ item, result: matchPurchaseProduct(product, item, {
      receivedAt, config, priorLink: priorIds.has(String(item.id)),
    }) })).filter(row => row.result).sort((a, b) => b.result.confidence - a.result.confidence);
    const best = ranked[0];
    if (!best || !best.result.match_status) {
      rejected.push({ product_index: index, product_name: product.product_name, reason: best?.result?.evidence || ['below suggestion threshold'] });
      continue;
    }
    matches.push({ buy_item_id: best.item.id, product_index: index, product_fingerprint: productFingerprint(product, index),
      confidence: best.result.confidence, match_status: best.result.match_status,
      match_reason: { evidence: best.result.evidence, signals: best.result.signals, version: PURCHASE_MATCHING_VERSION },
      product_name: product.product_name });
    for (const row of ranked.slice(1)) rejected.push({ product_index: index, product_name: product.product_name, candidate_id: row.item.id,
      reason: row.result.evidence, confidence: row.result.confidence });
  }
  return { matches, rejected, candidate_count: candidates.length };
}

export function canonicalListStatus(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  return normalized === 'bought' ? 'bought' : normalized === 'ready_to_buy' ? 'ready_to_buy' : 'looking';
}
