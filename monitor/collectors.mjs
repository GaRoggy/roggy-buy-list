import { MonitorError } from './core.mjs';
import { googleClient } from './google.mjs';
import { syncCalendar } from './calendar.mjs';
import { syncGmail } from './gmail.mjs';
import { syncGarmin } from './health.mjs';

export async function collect(source, env, store) {
  if (source.kind === 'calendar') return syncCalendar(source, await googleClient(env), await store.records('calendar_event'));
  if (source.kind === 'gmail') return syncGmail(source, await googleClient(env), await store.records('email'));
  if (source.kind === 'garmin') return syncGarmin();
  throw new MonitorError('INTEGRATION_NOT_CONFIGURED', { terminal: true });
}
