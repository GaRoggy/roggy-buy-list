import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCalendar, normalizeCalendar } from '../calendar.mjs';
test('all-day dates remain dates and exclusive end is preserved', () => {
  const r = normalizeCalendar({ id: 'a', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } }, 'calendar', 'America/Chicago');
  assert.equal(r.payload.start, '2026-11-01'); assert.equal(r.payload.all_day, true); assert.equal(r.payload.end, '2026-11-02');
});
test('complete calendar snapshot reconciles absent records without touching other calendars', async () => {
  const source = { id: 's', external_id: 'calendar@example.test' };
  const old = [{ source_id: 's', external_id: 'gone', payload: {} }, { source_id: 'other', external_id: 'keep', payload: {} }];
  const result = await syncCalendar(source, async () => ({ items: [{ id: 'new', start: {dateTime:'2026-10-01T10:00:00-05:00'}, end:{dateTime:'2026-10-01T11:00:00-05:00'} }] }), old);
  assert.deepEqual(result.records.map(r => [r.external_id, r.status]), [['new','processed'],['gone','deleted']]);
});
test('partial page failure never yields a destructive reconciliation', async () => {
  await assert.rejects(syncCalendar({id:'s',external_id:'calendar'}, async (_path,params) => {
    if(params.pageToken) throw Error('network'); return { items:[],nextPageToken:'next' };
  }, [{source_id:'s',external_id:'existing',payload:{}}]));
});
