import { MonitorError } from './core.mjs';

export async function collect() {
  throw new MonitorError('INTEGRATION_NOT_CONFIGURED', { terminal: true });
}
