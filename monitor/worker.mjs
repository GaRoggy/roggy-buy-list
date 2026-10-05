import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { config, Store, failure, backoff, log, MonitorError } from './core.mjs';
import { collect } from './collectors.mjs';
import { normalizeRecords } from './events.mjs';
import { flushUnifiedEventOutbox, normalizeUnifiedEvent } from './unified-events.mjs';
import { acquireProcessLock } from '../ai/shared/single-instance.mjs';

const HEARTBEAT_DIR = new URL('../logs/', import.meta.url);
const HEARTBEAT_FILE = new URL('../logs/monitor-heartbeat.json', import.meta.url);
const LOCK_FILE = new URL('../logs/monitor.lock', import.meta.url);

async function writeHeartbeat() {
  await mkdir(HEARTBEAT_DIR, { recursive: true });
  await writeFile(HEARTBEAT_FILE, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }), 'utf8');
}

async function enqueueCanonicalEvent(store, input, logger = log) {
  if (typeof store.enqueueUnifiedEvents !== 'function') return false;
  try {
    const event = normalizeUnifiedEvent(input);
    if (!event) return false;
    await store.enqueueUnifiedEvents([event]);
    return true;
  } catch (error) {
    await logger('unified_event_enqueue_failed', {
      source: input?.source, event_type: input?.event_type, error_code: failure(error).code,
    });
    return false;
  }
}

export async function runJob(store, claim, collector = collect, logger = log) {
  const { job, source } = claim;
  const started = Date.now();
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
    let eventsProcessed = 0;
    if (typeof store.upsertEvents === 'function') {
      try {
        eventsProcessed = await store.upsertEvents(source, normalizeRecords(result.records, source));
      } catch (error) {
        // Event projection is additive. A projection outage must not roll back
        // a successful provider cursor commit or cause duplicate reprocessing.
        await logger('event_projection_failed', { job_id: job.id, source_id: source.id,
          error_code: failure(error).code, duration_ms: Date.now() - started });
      }
    }
    if (source.kind === 'gmail' && typeof store.processPurchaseEmail === 'function') {
      let candidates = [];
      try { candidates = await store.purchaseCandidates(); } catch (error) {
        await logger('purchase_candidate_load_failed', { job_id: job.id, source_id: source.id, error_code: failure(error).code });
      }
      for (const record of result.records || []) {
        try {
          const decision = await store.processPurchaseEmail(source, record, candidates);
          if (decision) await logger('purchase_email_processed', { job_id: job.id, source_id: source.id,
            gmail_message_id: decision.gmail_message_id, classification: decision.email_type,
            merchant: decision.merchant, products_count: decision.products_count,
            candidate_count: decision.candidate_count, matches_created: decision.matches_created,
            suggestions_created: decision.suggestions_created, auto_matches: decision.auto_matches,
            suggested_matches: decision.suggested_matches, rejected_candidates: decision.rejected?.length || 0,
            lifecycle_events: decision.lifecycle_events });
        } catch (error) {
          await logger('purchase_email_processing_failed', { job_id: job.id, source_id: source.id, error_code: failure(error).code });
        }
      }
    }
    await logger('job_succeeded', { job_id: job.id, records_processed: count,
      events_processed: eventsProcessed, duration_ms: Date.now() - started });
    if (Number(job.attempts) > 1) {
      await enqueueCanonicalEvent(store, {
        event_id: `background-job:${job.id}:recovered`,
        event_type: 'background_job_recovered', category: 'background_job', source: 'monitor_worker',
        severity: 'notice', importance: 0.72, status: 'resolved', related_entity: job.id,
        title: 'Background job recovered after retry',
        summary: 'A scheduled provider job succeeded after an earlier retryable failure.',
        metadata: { job_id: job.id, attempt: job.attempts, provider_kind: source.kind || 'unknown' },
      }, logger);
    }
  } catch (error) {
    const err = failure(error);
    await store.rpc('fail', { ...fence, p_code: err.code, p_delay: Math.ceil(backoff(job.attempts, err.retryAfter)), p_terminal: err.terminal });
    await logger('job_failed', { job_id: job.id, error_code: err.code, duration_ms: Date.now() - started });
    await enqueueCanonicalEvent(store, {
      event_id: `background-job:${job.id}:${err.terminal ? 'failed' : 'deferred'}:${job.attempts}`,
      event_type: err.terminal ? 'background_job_failed' : 'background_job_deferred',
      category: 'background_job', source: 'monitor_worker', severity: err.terminal ? 'error' : 'warning',
      importance: err.terminal ? 0.78 : 0.66, status: 'active', related_entity: job.id,
      title: err.terminal ? 'Background job failed' : 'Background job deferred for retry',
      summary: err.terminal ? 'A scheduled provider job failed and requires attention.'
        : 'A scheduled provider job was deferred after a transient failure and will retry.',
      metadata: { job_id: job.id, attempt: job.attempts, error_code: err.code,
        retryable: !err.terminal, provider_kind: source.kind || 'unknown' },
    }, logger);
  } finally { clearInterval(timer); if (heartbeat) await heartbeat; }
}
async function main() {
  const lock = await acquireProcessLock(LOCK_FILE);
  try {
    const store = new Store(config()); let stopping = false;
    process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
    await enqueueCanonicalEvent(store, {
      event_id: `service:monitor-worker:started:${process.pid}`,
      event_type: 'service_restarted', category: 'service', source: 'monitor_worker',
      severity: 'notice', importance: 0.68, status: 'resolved', related_entity: 'monitor-worker',
      title: 'Monitor worker started',
      summary: 'The canonical event monitor worker started and acquired its process lock.',
      metadata: { process_id: process.pid },
    });
    do {
      try {
        await writeHeartbeat();
        const unified = await flushUnifiedEventOutbox(store);
        if (unified.flushed || unified.failed) {
          await log('unified_event_outbox_flush', {
            events_processed: unified.flushed,
            error_code: unified.failed ? unified.error_code : undefined,
          });
        }
        await store.rpc('schedule', { p_user: store.env.MONITOR_USER_ID });
        let claim;
        while (!stopping && (claim = await store.rpc('claim', { p_user: store.env.MONITOR_USER_ID }))) await runJob(store, claim);
      } catch (error) {
        await log('worker_error', { error_code: failure(error).code });
        try { await writeHeartbeat(); } catch { /* watchdog will treat a failed heartbeat as unhealthy */ }
      }
      if (process.argv.includes('--once')) break;
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 15000));
    } while (!stopping);
  } finally {
    await lock.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async error => { console.error(JSON.stringify({ event: 'startup_failed', error_code: failure(error).code })); process.exitCode = 1; });
}
