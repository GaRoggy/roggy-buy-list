import { pages, MonitorError } from './core.mjs';

function plainText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 65536);
  return (part.parts || []).map(plainText).join('\n').slice(0, 65536);
}
export function classifyEmail(message) {
  const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  const subject = headers.subject || '', labels = new Set(message.labelIds || []);
  const body = plainText(message.payload) || message.snippet || '';
  const text = `${subject}\n${body}`;
  const rules = [
    ['security', /(?:unrecognized|unusual|suspicious) (?:sign.?in|login|activity)|security (?:alert|notice)|password (?:changed|reset)/i],
    ['school', /\b(exam|professor|syllabus|assignment|tuition|class cancelled)\b/i],
    ['bills', /\b(bill|invoice|payment due|past due|amount due)\b/i],
    ['shipping', /\b(tracking|shipped|shipment|out for delivery|package arriving|delivered)\b/i],
    ['travel', /\b(itinerary|boarding|flight|hotel reservation|booking confirmation)\b/i],
    ['appointments', /\b(appointment|reservation reminder)\b/i],
    ['calendar', /\b(invitation|rescheduled|calendar|meeting cancelled)\b/i],
    ['payments', /\b(payment received|payment confirmation|payment processed)\b/i],
    ['receipts', /\b(receipt|purchase confirmation)\b/i],
    ['orders', /\b(order confirmation|order number|order placed)\b/i],
    ['subscriptions', /\b(subscription|renewal|membership)\b/i],
    ['work', /\b(interview|recruiter|project deadline|work meeting)\b/i],
  ];
  let category = rules.find(([, regex]) => regex.test(text))?.[0] || (labels.has('IMPORTANT') ? 'personal' : 'unimportant');
  const promotional = labels.has('CATEGORY_PROMOTIONS') || /\b(\d+% off|sale ends|shop now|limited.time offer|promo code)\b/i.test(subject);
  const newsletter = /\b(newsletter|weekly digest|daily digest)\b/i.test(subject) || (!!headers['list-unsubscribe'] && !rules.some(([,r]) => r.test(subject)));
  if (labels.has('SPAM') || labels.has('TRASH') || labels.has('SENT')) category = 'unimportant';
  else if (promotional) category = 'promotions';
  else if (newsletter) category = 'newsletters';
  const reasons = {
    security: 'The message reports an account security change or suspicious sign-in.',
    bills: 'The message mentions a bill, invoice or payment due.',
    shipping: 'The message contains a package delivery or shipping update.',
    appointments: 'The message concerns an appointment.',
    calendar: 'The message reports scheduling information.',
    travel: 'The message contains travel or reservation information.',
    personal: 'Gmail marked this message important.',
  };
  if (['school', 'work'].includes(category) && /\b(moved|changed|cancelled|deadline|due|interview)\b/i.test(text)) reasons[category] = 'The message mentions an actionable school or work schedule change.';
  const due = text.match(/\b(?:due|pay by|deadline)\s*(?:on|:)?\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1] || null;
  const amount = text.match(/\b(USD|EUR|GBP)\s*(\d+(?:,\d{3})*(?:\.\d{2})?)\b/);
  const order = text.match(/\border (?:number|id|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,40})\b/i)?.[1] || null;
  const tracking = text.match(/\btracking (?:number|id|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{7,40})\b/i)?.[1] || null;
  return { sender: headers.from || null, subject, timestamp: new Date(Number(message.internalDate)).toISOString(),
    category, summary: (message.snippet || '').slice(0, 500), summary_method: 'provider_snippet',
    required_action: due ? 'Review the stated deadline.' : null, due_date: due,
    monetary_amount: amount ? { amount: amount[2].replaceAll(',', ''), currency: amount[1] } : null,
    company_person: headers.from || null, order_information: order, tracking_information: tracking,
    event_information: null, urgency: category === 'security' ? 'IMPORTANT' : 'NOTICE',
    dashboard: !!reasons[category], reason: reasons[category] || null,
    source_message_id: message.id, thread_id: message.threadId, classifier_version: 1,
    extraction_notes: 'Deterministic, conservative extraction. Ambiguous amounts, relative dates and event details remain unknown.' };
}
export async function syncGmail(source, get, existing = []) {
  const base = 'gmail/v1/users/me/';
  let historyId = source.cursor?.historyId, ids = new Set(), finalId;
  if (historyId) {
    try {
      let token;
      do {
        const data = await get(base + 'history', { startHistoryId: historyId, maxResults: '500', ...(token ? {pageToken:token} : {}) });
        for (const history of data.history || []) for (const message of history.messages || []) ids.add(message.id);
        token = data.nextPageToken; finalId = data.historyId;
      } while (token);
    } catch (e) { if (e.status !== 404) throw e; historyId = null; ids = new Set(); }
  }
  if (!historyId) {
    // Capture BEFORE listing; changes during bootstrap are replayed next time.
    finalId = (await get(base + 'profile')).historyId;
    const recent = await pages(get, base + 'messages', { q: 'newer_than:90d', includeSpamTrash: 'true', maxResults: '500' });
    for (const message of recent.items) ids.add(message.id);
    for (const row of existing.filter(r => r.source_id === source.id)) ids.add(row.external_id);
  }
  if (!finalId) throw new MonitorError('GMAIL_CURSOR_MISSING');
  const records = [];
  for (const id of ids) {
    try {
      const message = await get(base + `messages/${encodeURIComponent(id)}`, { format: 'full' });
      const payload = classifyEmail(message);
      records.push({ kind: 'email', external_id: id, occurred_at: payload.timestamp, payload });
    } catch (e) {
      if (e.status !== 404) throw e;
      records.push({ kind: 'email', external_id: id, status: 'deleted', occurred_at: null, payload: {} });
    }
  }
  return { records, cursor: { historyId: finalId } };
}
