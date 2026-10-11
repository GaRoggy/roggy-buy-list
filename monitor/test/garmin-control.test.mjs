import test from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://garoggy.github.io';
const OWNER_A = '00000000-0000-0000-0000-000000000101';
const OWNER_B = '00000000-0000-0000-0000-000000000202';
const SOURCE_A = '00000000-0000-0000-0000-000000000301';
const SOURCE_B = '00000000-0000-0000-0000-000000000302';
const JOB_A = '00000000-0000-0000-0000-000000000401';
const JOB_B = '00000000-0000-0000-0000-000000000402';
const state = {};
let handler;

function emptyState() {
  return { monitor_sources: [], monitor_records: [], monitor_events: [], monitor_jobs: [], monitor_runs: [],
    restRequests: [], recordInsertCalls: 0, failRecordBatchAt: 0, nextRecordId: 1 };
}
function reset() { Object.assign(state, emptyState()); }
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function matches(value, condition) {
  if (!condition) return true;
  if (condition.startsWith('eq.')) return String(value) === condition.slice(3);
  if (condition.startsWith('in.(') && condition.endsWith(')')) return condition.slice(4, -1).split(',').includes(String(value));
  return false;
}
function filteredRows(rows, query) {
  return rows.filter(row => [...query.entries()].every(([key, value]) =>
    ['select', 'limit', 'order', 'on_conflict'].includes(key) || matches(row[key], value)));
}
function bodyOf(init) { return init.body ? JSON.parse(String(init.body)) : null; }
function minimalResponse(status = 204) { return new Response(null, { status }); }
function handleRest(url, init) {
  const table = url.pathname.split('/').at(-1);
  const rows = state[table];
  const method = String(init.method || 'GET').toUpperCase();
  const query = url.searchParams;
  if (!Array.isArray(rows)) return jsonResponse({ error: 'unknown table' }, 404);
  if (method === 'GET') return jsonResponse(filteredRows(rows, query));
  if (method === 'POST' && table === 'monitor_sources') {
    const created = [];
    for (const input of bodyOf(init) || []) {
      let row = rows.find(item => item.user_id === input.user_id && item.kind === input.kind && item.external_id === input.external_id);
      if (row) Object.assign(row, input);
      else { row = { ...input, id: SOURCE_A }; rows.push(row); }
      created.push(row);
    }
    return init.headers?.Prefer?.includes('return=representation') || init.headers?.prefer?.includes('return=representation')
      ? jsonResponse(created, 201) : minimalResponse(201);
  }
  if (method === 'POST' && table === 'monitor_records') {
    state.recordInsertCalls++;
    if (state.failRecordBatchAt === state.recordInsertCalls) return jsonResponse({ error: 'synthetic database failure' }, 500);
    for (const input of bodyOf(init) || []) {
      const row = rows.find(item => item.source_id === input.source_id && item.kind === input.kind && item.external_id === input.external_id);
      if (row) Object.assign(row, input);
      else rows.push({ ...input, id: `record-${state.nextRecordId++}` });
    }
    return minimalResponse(201);
  }
  if (method === 'PATCH') {
    for (const row of filteredRows(rows, query)) Object.assign(row, bodyOf(init) || {});
    return minimalResponse();
  }
  if (method === 'DELETE') {
    const removed = new Set(filteredRows(rows, query));
    state[table] = rows.filter(row => !removed.has(row));
    return minimalResponse();
  }
  return jsonResponse({ error: 'unsupported mock request' }, 405);
}

reset();
globalThis.Deno = {
  env: { get: name => ({ SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_ANON_KEY: 'fixture-public-key',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key' })[name] },
  serve: fn => { handler = fn; },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const headers = new Headers(init.headers);
  if (url.pathname === '/auth/v1/user') {
    return headers.get('authorization') === 'Bearer test-owner-session'
      ? jsonResponse({ id: OWNER_A }) : jsonResponse({ message: 'invalid token' }, 401);
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    state.restRequests.push({ url, method: String(init.method || 'GET').toUpperCase(), headers, body: bodyOf(init) });
    return handleRest(url, init);
  }
  return jsonResponse({ error: 'unexpected URL' }, 404);
};
await import('../../supabase/functions/garmin-control/index.ts');
test.after(() => { globalThis.fetch = originalFetch; delete globalThis.Deno; });

async function invoke(body, { token = 'test-owner-session', origin = ORIGIN, contentType = 'application/json' } = {}) {
  const response = await handler(new Request('https://fixture.supabase.co/functions/v1/garmin-control', {
    method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  const result = await response.json();
  return { status: response.status, result };
}
const sampleCsv = (steps = 8450) => 'Date,Steps,Active Calories,Distance (mi),Sleep Duration,Sleep Score,Activity Type,Total Time,Avg HR,Calories\n' +
  `2026-10-09,${steps},0,3.1,7:12:00,82,Running,00:35:00,150,350\n`;

test('authenticates the caller and rejects unsupported origins before any database request', async () => {
  reset();
  const invalid = await invoke({ action: 'import-csv', csv: sampleCsv() }, { token: 'forged-token' });
  assert.equal(invalid.status, 401);
  const forbidden = await invoke({ action: 'import-csv', csv: sampleCsv() }, { origin: 'https://attacker.example' });
  assert.equal(forbidden.status, 403);
  assert.equal(state.restRequests.length, 0);
});

test('rejects malformed or oversized uploads before creating a Garmin source', async () => {
  reset();
  const malformed = await invoke({ action: 'import-csv', csv: 'Date,Unknown metric\n2026-10-09,123\n' });
  assert.equal(malformed.status, 422);
  assert.equal(malformed.result.error_code, 'GARMIN_CSV_NO_SUPPORTED_RECORDS');
  assert.equal(state.monitor_sources.length, 0);
  const wrongType = await invoke({ action: 'import-csv', csv: sampleCsv() }, { contentType: 'text/plain' });
  assert.equal(wrongType.status, 415);
  const tooLarge = await invoke(JSON.stringify({ action: 'import-csv', padding: 'x'.repeat(14 * 1024 * 1024) }));
  assert.equal(tooLarge.status, 413);
  assert.equal(state.monitor_sources.length, 0);
  assert.equal(state.monitor_records.length, 0);
});

test('normalizes, owner-scopes, and deduplicates real-format CSV records with source timezone', async () => {
  reset();
  const imported = await invoke({ action: 'import-csv', user_id: OWNER_B, csv: sampleCsv(), source_timezone: 'America/Chicago' });
  assert.equal(imported.status, 200);
  assert.equal(imported.result.ok, true);
  assert.ok(imported.result.imported >= 5);
  assert.equal(state.monitor_sources.length, 1);
  assert.equal(state.monitor_sources[0].user_id, OWNER_A);
  assert.equal(state.monitor_sources[0].enabled, false);
  assert.equal(state.monitor_sources[0].config.credentials_stored, false);
  assert.ok(state.monitor_sources[0].last_success_at);
  assert.ok(state.monitor_records.every(row => row.user_id === OWNER_A && row.source_id === SOURCE_A));
  const steps = state.monitor_records.find(row => row.payload.metric === 'steps');
  assert.equal(steps.payload.value, 8450);
  assert.equal(steps.occurred_at, '2026-10-09T17:00:00.000Z');
  assert.equal(state.monitor_records.find(row => row.payload.metric === 'active_calories').payload.value, 0);
  assert.equal(state.monitor_records.some(row => row.payload.metric === 'hrv'), false);
  assert.doesNotMatch(JSON.stringify(state.monitor_records), /Date,Steps|positionLat|positionLong|garmin-export\.zip/i);

  const initialCount = state.monitor_records.length;
  const corrected = await invoke({ action: 'import-csv', csv: sampleCsv(9000), source_timezone: 'America/Chicago' });
  assert.equal(corrected.status, 200);
  assert.equal(state.monitor_records.length, initialCount);
  assert.equal(state.monitor_records.find(row => row.payload.metric === 'steps').payload.value, 9000);
  const writes = state.restRequests.filter(call => call.method === 'POST' && call.url.pathname.endsWith('/monitor_records'));
  assert.ok(writes.every(call => call.body.every(row => row.user_id === OWNER_A && row.source_id === SOURCE_A)));
  assert.ok(state.restRequests.every(call => call.headers.get('apikey') === 'fixture-service-key'));
});

test('a failed multi-batch import can be safely retried without duplicates', async () => {
  reset();
  const rows = ['Date,Steps'];
  const first = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 301; i++) rows.push(`${new Date(first + i * 86400000).toISOString().slice(0, 10)},${1000 + i}`);
  state.failRecordBatchAt = 2;
  const failed = await invoke({ action: 'import-csv', csv: rows.join('\n'), source_timezone: 'UTC' });
  assert.equal(failed.status, 503);
  assert.equal(failed.result.error_code, 'GARMIN_IMPORT_RETRY_SAFE');
  assert.equal(state.monitor_records.length, 300);
  assert.equal(state.monitor_sources[0].last_success_at, undefined);

  state.failRecordBatchAt = 0;
  const retried = await invoke({ action: 'import-csv', csv: rows.join('\n'), source_timezone: 'UTC' });
  assert.equal(retried.status, 200);
  assert.equal(state.monitor_records.length, 301);
  assert.ok(state.monitor_sources[0].last_success_at);
});

test('deletion requires explicit confirmation and cannot remove another owner’s Garmin rows', async () => {
  reset();
  const imported = await invoke({ action: 'import-csv', csv: sampleCsv() });
  assert.equal(imported.status, 200);
  state.monitor_sources.push({ id: SOURCE_B, user_id: OWNER_B, kind: 'garmin', external_id: 'official-export-import', enabled: false });
  state.monitor_records.push({ id: 'other-record', user_id: OWNER_B, source_id: SOURCE_B, kind: 'health_measurement', external_id: 'other', payload: { metric: 'steps', value: 12 } });
  state.monitor_events.push({ id: 'event-a', user_id: OWNER_A, source_kind: 'garmin' }, { id: 'event-b', user_id: OWNER_B, source_kind: 'garmin' });
  state.monitor_jobs.push({ id: JOB_A, user_id: OWNER_A, source_id: SOURCE_A }, { id: JOB_B, user_id: OWNER_B, source_id: SOURCE_B });
  state.monitor_runs.push({ id: 1, user_id: OWNER_A, job_id: JOB_A }, { id: 2, user_id: OWNER_B, job_id: JOB_B });

  const before = Object.fromEntries(['monitor_sources', 'monitor_records', 'monitor_events', 'monitor_jobs', 'monitor_runs'].map(key => [key, state[key].length]));
  const unconfirmed = await invoke({ action: 'delete-all', user_id: OWNER_B, confirmation: 'wrong phrase' });
  assert.equal(unconfirmed.status, 400);
  assert.deepEqual(Object.fromEntries(Object.keys(before).map(key => [key, state[key].length])), before);

  const deleted = await invoke({ action: 'delete-all', user_id: OWNER_B, confirmation: 'DELETE ALL GARMIN DATA' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.result.deleted, true);
  for (const table of ['monitor_sources', 'monitor_records', 'monitor_events', 'monitor_jobs', 'monitor_runs']) {
    assert.equal(state[table].some(row => row.user_id === OWNER_A), false, `${table} retained the requesting owner's Garmin data`);
    assert.equal(state[table].some(row => row.user_id === OWNER_B), true, `${table} removed another owner's data`);
  }
  for (const call of state.restRequests.filter(call => call.method === 'DELETE')) assert.equal(call.url.searchParams.get('user_id'), `eq.${OWNER_A}`);
});
