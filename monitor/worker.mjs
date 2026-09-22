import { pathToFileURL } from 'node:url';
import { config, Store, failure, backoff, log, MonitorError } from './core.mjs';
import { collect } from './collectors.mjs';

export async function runJob(store, claim, collector = collect, logger = log) {
  const { job, source } = claim;
  const fence = { p_job: job.id, p_token: job.lease_token };
  let lost = false, heartbeat;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = store.rpc('heartbeat', fence).then(ok => { if (!ok) lost = true; })
      .catch(() => { lost = true; }).finally(() => { heartbeat = null; });
  }, 30000);
  try {
    await logger('job_started', { job_id: job.id, source_id: source.id, attempt: job.attempts });
    const result = await collector(source, store.env, store);
    if (lost) throw new MonitorError('STALE_LEASE');
    const count = await store.rpc('commit', { ...fence, p_records: result.records, p_cursor: result.cursor });
    await logger('job_succeeded', { job_id: job.id, records_processed: count });
  } catch (error) {
    const err = failure(error);
    await store.rpc('fail', { ...fence, p_code: err.code, p_delay: Math.ceil(backoff(job.attempts, err.retryAfter)), p_terminal: err.terminal });
    await logger('job_failed', { job_id: job.id, error_code: err.code });
  } finally { clearInterval(timer); if (heartbeat) await heartbeat; }
}
async function main() {
  const store = new Store(config()); let stopping = false;
  process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
  do {
    try {
      await store.rpc('schedule', { p_user: store.env.MONITOR_USER_ID });
      let claim;
      while (!stopping && (claim = await store.rpc('claim', { p_user: store.env.MONITOR_USER_ID }))) await runJob(store, claim);
    } catch (error) { await log('worker_error', { error_code: failure(error).code }); }
    if (process.argv.includes('--once')) break;
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 15000));
  } while (!stopping);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async error => { console.error(JSON.stringify({ event: 'startup_failed', error_code: failure(error).code })); process.exitCode = 1; });
}
