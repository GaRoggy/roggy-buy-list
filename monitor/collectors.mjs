import { MonitorError } from './core.mjs';
import { googleClient } from './google.mjs';
import { syncCalendar } from './calendar.mjs';

export async function collect(source, env, store) {
  if (source.kind === 'calendar') return syncCalendar(source, await googleClient(env), await store.records('calendar_event'));
  throw new MonitorError('INTEGRATION_NOT_CONFIGURED', { terminal: true });
}
