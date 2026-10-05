import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudWindow, normalizeCloudCalendarEvent, reconcileCloudCalendarRecords, shouldFullCalendarSync } from '../calendar-cloud.mjs';

test('cloud calendar normalization preserves timezone, location and recurrence metadata', () => {
  const result = normalizeCloudCalendarEvent({
    id: 'series_20261006T000000Z', recurringEventId: 'series',
    originalStartTime: { dateTime: '2026-10-06T19:00:00-05:00', timeZone: 'America/Chicago' },
    summary: 'Band Practice', location: "Paiden's parents house",
    start: { dateTime: '2026-10-06T19:00:00-05:00', timeZone: 'America/Chicago' },
    end: { dateTime: '2026-10-06T21:00:00-05:00', timeZone: 'America/Chicago' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'], updated: '2026-09-29T12:00:00Z'
  }, 'owner-calendar', 'America/Chicago');
  assert.equal(result.external_id, 'series_20261006T000000Z');
  assert.equal(result.payload.location, "Paiden's parents house");
  assert.equal(result.payload.recurring_event_id, 'series');
  assert.deepEqual(result.payload.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU']);
});

test('full cloud reconciliation creates tombstones only for records absent from the bounded window', () => {
  const rows = reconcileCloudCalendarRecords([
    { id: 'kept', summary: 'Kept', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } }
  ], [{ external_id: 'kept', payload: {} }, { external_id: 'removed', payload: { title: 'Removed' }, occurred_at: '2026-09-20T00:00:00Z' }], 'cal');
  assert.equal(rows.length, 2);
  assert.equal(rows.find(x => x.external_id === 'removed').status, 'deleted');
});

test('cloud cursor uses incremental sync between bounded full reconciliations', () => {
  assert.equal(shouldFullCalendarSync({}, new Date('2026-09-29T00:00:00Z')), true);
  assert.equal(shouldFullCalendarSync({ sync_token: 't', full_sync_at: '2026-09-28T12:00:00Z' }, new Date('2026-09-29T00:00:00Z')), false);
  assert.equal(shouldFullCalendarSync({ sync_token: 't', full_sync_at: '2026-09-28T00:00:00Z' }, new Date('2026-09-29T12:01:00Z')), true);
  const window = cloudWindow(new Date('2026-09-29T00:00:00Z'));
  assert.equal(window.timeMin, '2026-09-22T00:00:00.000Z');
  assert.equal(window.timeMax, '2026-12-28T00:00:00.000Z');
});

test('malformed provider times fail closed before reminder projection can cast them', () => {
  assert.throws(() => normalizeCloudCalendarEvent({ id: 'bad', start: { dateTime: 'not-a-date' }, end: { dateTime: '2026-10-01T01:00:00Z' } }, 'cal'), /CALENDAR_EVENT_TIME_INVALID/);
});
