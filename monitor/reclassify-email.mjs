/* Reclassify existing bounded Gmail records without fetching or retaining raw
 * message bodies. Preview is the default; pass --apply to update payloads. */
import { config, Store } from './core.mjs';
import { routeEmail } from './email-routing.mjs';
import { semanticCacheKey } from './email-semantics.mjs';

async function main() {
  const env = config();
  const store = new Store(env);
  const records = await store.records('email');
  const candidates = records.filter(record => record.status !== 'deleted' && Number(record.payload?.classifier_version || 0) < 3);
  const updates = candidates.map(record => {
    const p = record.payload && typeof record.payload === 'object' ? record.payload : {};
    const routing = routeEmail({ category: p.category, labels: p.labels, text: p.summary || '', sender: p.sender || '', subject: p.subject || '', due_date: p.due_date, required_action: p.required_action });
    return { id: record.id, payload: { ...p, ...routing, dashboard: routing.route === 'dashboard', classifier_version: 3,
      semantic_cache_key: semanticCacheKey({ source_message_id: p.source_message_id || record.external_id, category: p.category,
        labels: p.labels, sender: p.sender, subject: p.subject, text: p.summary || '' }) } };
  });
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ dry_run: true, eligible_records: updates.length, route_counts: Object.fromEntries([...new Set(updates.map(row => row.payload.route))].map(route => [route, updates.filter(row => row.payload.route === route).length])) }));
    return;
  }
  let updated = 0;
  for (const row of updates) {
    await store.api(`monitor_records?id=eq.${encodeURIComponent(row.id)}&user_id=eq.${encodeURIComponent(env.MONITOR_USER_ID)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ payload: row.payload }),
    });
    updated++;
  }
  console.log(JSON.stringify({ dry_run: false, updated }));
}
main().catch(error => { console.error(error?.code || 'EMAIL_RECLASSIFICATION_FAILED'); process.exitCode = 1; });
