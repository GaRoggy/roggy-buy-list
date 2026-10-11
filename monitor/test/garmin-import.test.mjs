import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Encoder, Profile } from '@garmin/fitsdk';
import { normalizeGarminCsv, normalizeGarminFitMessages, validateImportedRecords } from '../../supabase/functions/_shared/garmin-normalize.js';
import { decodeFit, persistGarminExport, readGarminExport } from '../garmin-import.mjs';

test('Garmin CSV export maps only present metrics and keeps zero distinct from missing', async () => {
  const csv = 'Date,Steps,Active Calories,Distance (mi),Sleep Duration,Sleep Score,Activity Type,Total Time,Avg HR,Calories\n' +
    '2026-10-09,8450,0,3.1,7:12:00,82,Running,00:35:00,150,350\n';
  const result = await normalizeGarminCsv(csv, { sourceTimezone: 'America/Chicago' });
  const metrics = result.records.filter(row => row.kind === 'health_measurement');
  const get = name => metrics.find(row => row.payload.metric === name)?.payload.value;
  assert.equal(get('steps'), 8450);
  assert.equal(get('active_calories'), 0);
  const activity = result.records.find(row => row.kind === 'garmin_activity');
  assert.ok(Math.abs(activity.payload.distance_meters - 4988.9664) < 0.001);
  assert.equal(get('sleep_duration'), 25920);
  assert.equal(get('sleep_score'), 82);
  assert.equal(get('hrv'), undefined);
  assert.equal(result.records.filter(row => row.kind === 'garmin_activity').length, 1);
  assert.equal(result.records.find(row => row.kind === 'garmin_activity').payload.activity_type, 'run');
  assert.equal(result.records.find(row => row.kind === 'garmin_activity').payload.gps_included, false);
  assert.equal(new Date(metrics[0].occurred_at).toISOString(), '2026-10-09T17:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(result.records), /positionLat|positionLong|latitude|longitude/i);
});

test('CSV handles quotes and resolves a repeated local fall-back time deterministically', async () => {
  const quoted = await normalizeGarminCsv('Date,Activity Type,Calories\n"11/01/2026 01:30 AM","Run, Trail",200\n', { sourceTimezone: 'America/Chicago' });
  const parsed = await normalizeGarminCsv('Date,Steps\n11/01/2026 01:30 AM,20\n', { sourceTimezone: 'America/Chicago' });
  assert.equal(quoted.records.find(row => row.kind === 'garmin_activity').payload.activity_type, 'run');
  assert.equal(parsed.records[0].occurred_at, '2026-11-01T06:30:00.000Z');
  assert.equal(parsed.records[0].payload.time_resolution, 'ambiguous_local_time_earlier_occurrence');
  const nonexistent = await normalizeGarminCsv('Date,Steps\n03/08/2026 02:30 AM,10\n', { sourceTimezone: 'America/Chicago' });
  assert.equal(nonexistent.records.length, 0);
  assert.equal(nonexistent.warnings.length, 1);
});

test('official Garmin FIT SDK decoding extracts summary data without coordinates', async () => {
  const encoder = new Encoder();
  encoder.writeMesg({ mesgNum: Profile.MesgNum.MONITORING, timestamp: new Date('2026-10-09T17:00:00Z'),
    activityType: 'walking', cycles: 3100, distance: 4800, calories: 1800, activeCalories: 350,
    activeTime: 3600000, heartRate: 61 });
  encoder.writeMesg({ mesgNum: Profile.MesgNum.SESSION, timestamp: new Date('2026-10-09T18:00:00Z'),
    startTime: new Date('2026-10-09T17:20:00Z'), totalElapsedTime: 2400, totalTimerTime: 2300,
    totalDistance: 5000, totalCalories: 300, avgHeartRate: 145, maxHeartRate: 171, totalAscent: 80,
    avgSpeed: 2.1, sport: 'running' });
  const bytes = Buffer.from(encoder.close());
  const decoded = await decodeFit(bytes, { sourceTimezone: 'America/Chicago' });
  const heartRate = decoded.find(row => row.payload?.metric === 'heart_rate');
  const steps = decoded.find(row => row.payload?.metric === 'steps');
  const activity = decoded.find(row => row.kind === 'garmin_activity');
  assert.equal(heartRate.payload.value, 61);
  assert.equal(steps, undefined);
  assert.equal(activity.payload.activity_type, 'run');
  assert.equal(activity.payload.distance_meters, 5000);
  assert.equal(activity.payload.gps_included, false);
  assert.doesNotMatch(JSON.stringify(decoded), /positionLat|positionLong|latitude|longitude/i);
});

test('sleep-level FIT messages yield only measured stage durations', async () => {
  const rows = await normalizeGarminFitMessages({ sleepLevelMesgs: [
    { timestamp: new Date('2026-10-09T04:00:00Z'), sleepLevel: 'light' },
    { timestamp: new Date('2026-10-09T04:30:00Z'), sleepLevel: 'deep' },
    { timestamp: new Date('2026-10-09T05:00:00Z'), sleepLevel: 'rem' },
  ] }, { sourceTimezone: 'UTC' });
  const values = Object.fromEntries(rows.map(row => [row.payload.metric, row.payload.value]));
  assert.equal(values.light_sleep_duration, 1800);
  assert.equal(values.deep_sleep_duration, 1800);
  assert.equal(values.sleep_duration, 3600);
});

test('re-exporting a corrected CSV keeps stable identities for matching days and activities', async () => {
  const original = await normalizeGarminCsv('Date,Steps,Activity Type,Activity ID,Total Time,Distance\n2026-10-09,8450,Running,12345,00:35:00,5\n', { sourceTimezone: 'UTC' });
  const expanded = await normalizeGarminCsv('Date,Steps,Activity Type,Activity ID,Total Time,Distance\n2026-10-09,9000,Running,12345,00:35:00,5\n2026-10-10,6000,Walking,67890,00:25:00,2\n', { sourceTimezone: 'UTC' });
  const oldSteps = original.records.find(row => row.payload?.metric === 'steps');
  const newSteps = expanded.records.find(row => row.payload?.metric === 'steps');
  const oldActivity = original.records.find(row => row.kind === 'garmin_activity');
  const newActivity = expanded.records.find(row => row.kind === 'garmin_activity');
  assert.equal(oldSteps.external_id, newSteps.external_id);
  assert.equal(newSteps.payload.value, 9000);
  assert.equal(oldActivity.external_id, newActivity.external_id);
});

test('extracted export folder dry-run merges overlapping CSV rows by stable identity', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'garmin-import-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'health-old.csv'), 'Date,Steps\n2026-10-09,8450\n');
  await writeFile(join(folder, 'health-corrected.csv'), 'Date,Steps\n2026-10-09,9000\n');
  await utimes(join(folder, 'health-old.csv'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  await utimes(join(folder, 'health-corrected.csv'), new Date('2026-10-02T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
  const preview = await readGarminExport(folder, { sourceTimezone: 'UTC' });
  assert.equal(preview.files_read, 2);
  assert.equal(preview.records.length, 1);
  assert.equal(preview.records[0].payload.value, 9000);
  assert.deepEqual(preview.metrics, ['steps']);
  assert.equal(preview.warnings, 1);
  assert.equal(preview.coverage.from, '2026-10-09T12:00:00.000Z');
});

test('import validation strips unexpected fields and rejects GPS or unbounded records', async () => {
  const [record] = (await normalizeGarminCsv('Date,Steps\n2026-10-09,40\n', { sourceTimezone: 'UTC' })).records;
  const safe = validateImportedRecords([{ ...record, payload: { ...record.payload, password: 'secret' } }]);
  assert.equal('password' in safe[0].payload, false);
  assert.throws(() => validateImportedRecords([{ ...record, external_id: 'garmin:raw-file' }]), /INVALID_GARMIN_RECORD/);
  assert.throws(() => validateImportedRecords([{ ...record, payload: { ...record.payload, value: 999999 } }]), /INVALID_GARMIN_MEASUREMENT/);
});

test('Supabase import uses owner-scoped source IDs, private rows and idempotent upserts', async () => {
  const calls = [];
  const store = { env: { MONITOR_USER_ID: '00000000-0000-0000-0000-000000000001' }, async api(path, options = {}) {
    calls.push({ path, options });
    if (path.startsWith('monitor_sources?') && options.method === 'POST') return [{ id: 'source-id' }];
    if (path.startsWith('monitor_sources?')) return [];
    return null;
  } };
  const result = await persistGarminExport([{ kind:'health_measurement', external_id:`export:${'b'.repeat(24)}:steps:2026-10-09T12:00:00.000Z`,
    occurred_at:'2026-10-09T12:00:00.000Z', status:'processed', payload:{metric:'steps',value:20,unit:'count',source_format:'garmin_export'} }], store);
  assert.equal(result.records_written, 1);
  assert.equal(calls.filter(item => item.path.startsWith('monitor_records?on_conflict=')).length, 1);
  const rows = JSON.parse(calls.find(item => item.path.startsWith('monitor_records?on_conflict=')).options.body);
  assert.equal(rows[0].user_id, store.env.MONITOR_USER_ID);
  assert.equal(rows[0].source_id, 'source-id');
  assert.equal(rows[0].status, 'processed');
  assert.match(calls.find(item => item.path.startsWith('monitor_records?on_conflict=')).path, /on_conflict=source_id,kind,external_id/);
});
