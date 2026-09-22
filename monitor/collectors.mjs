import { MonitorError } from './core.mjs';
import { googleClient } from './google.mjs';
import { syncCalendar } from './calendar.mjs';
import { syncGmail } from './gmail.mjs';
import { syncGarmin } from './health.mjs';
import { plaidClient, syncFinance } from './finance.mjs';

export async function collect(source, env, store) {
  if (source.kind === 'calendar') return syncCalendar(source, await googleClient(env), await store.records('calendar_event'));
  if (source.kind === 'gmail') return syncGmail(source, await googleClient(env), await store.records('email'));
  if (source.kind === 'garmin') return syncGarmin();
  if (source.kind === 'finance') {
    if(source.external_id!==env.PLAID_ITEM_ID)throw new MonitorError('PLAID_ITEM_MISMATCH',{terminal:true});
    return syncFinance(source,plaidClient(env));
  }
  throw new MonitorError('INTEGRATION_NOT_CONFIGURED', { terminal: true });
}
