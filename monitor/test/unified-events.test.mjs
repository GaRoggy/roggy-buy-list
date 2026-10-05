import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushSupabaseUnifiedEventOutbox, flushUnifiedEventOutbox, normalizeUnifiedEvent } from '../unified-events.mjs';

const owner = '9c1fcb62-644b-486a-9f87-36246e2e50de';

test('unified event normalization is bounded and privacy filtered', () => {
  const event = normalizeUnifiedEvent({
    event_id: 'website:list_item:1:updated:1', event_type: 'list_item_updated', category: 'list', source: 'website',
    title: 'A list item changed', summary: 'Milk is now bought.', importance: 0.42,
    metadata: { list_type: 'buy', token: 'do-not-store', nested: { transcript: 'do-not-store', status: 'bought' } },
  }, new Date('2026-10-05T12:00:00Z'));
  assert.equal(event.event_id, 'website:list_item:1:updated:1');
  assert.equal(event.metadata.token, undefined);
  assert.equal(event.metadata.nested.transcript, undefined);
  assert.equal(event.metadata.nested.status, 'bought');
  assert.equal(event.source, 'website');
});

test('low-importance and explicit noise events are excluded', () => {
  assert.equal(normalizeUnifiedEvent({ event_type: 'heartbeat', category: 'system', source: 'test', title: 'Heartbeat', importance: 0.1 }), null);
  assert.equal(normalizeUnifiedEvent({ event_type: 'state_changed', category: 'device', source: 'test', title: 'State', importance: 0.5, noise: true }), null);
});

test('same source event inputs receive a stable derived id', () => {
  const input = { event_type: 'device_outage', category: 'device', source: 'smart_home', title: 'Device offline', importance: 0.8, dedupe_key: 'device:lamp:offline', timestamp: '2026-10-05T12:00:00Z' };
  assert.equal(normalizeUnifiedEvent(input).event_id, normalizeUnifiedEvent(input).event_id);
});

test('Supabase outbox events are normalized, persisted, and removed after success', async () => {
  const rows = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event: {
    event_id: 'website:reminder:1:completed:1', event_type: 'reminder_completed', category: 'task', source: 'website',
    title: 'A reminder was completed', summary: 'A reminder was marked complete.', importance: 0.52,
  } }];
  const calls = [];
  const store = {
    env: { MONITOR_USER_ID: owner },
    api: async (path, options = {}) => { calls.push([path, options.method || 'GET']); return options.method === 'DELETE' ? null : rows; },
    upsertUnifiedEvents: async events => { calls.push(['upsert', events]); return events.length; },
  };
  const result = await flushSupabaseUnifiedEventOutbox(store);
  assert.deepEqual(result, { queued: 1, flushed: 1, failed: 0 });
  assert.equal(calls[1][0], 'upsert');
  assert.equal(calls[1][1][0].category, 'task');
  assert.equal(calls[2][1], 'DELETE');
});

test('Supabase outbox remains queued when canonical persistence fails', async () => {
  const store = {
    env: { MONITOR_USER_ID: owner },
    api: async () => [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event: { event_type: 'project_created', category: 'project', source: 'website', title: 'Project', importance: 0.5 } }],
    upsertUnifiedEvents: async () => { throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }); },
  };
  assert.deepEqual(await flushSupabaseUnifiedEventOutbox(store), { queued: 1, flushed: 0, failed: 1, error_code: 'NETWORK_ERROR' });
});

test('local outbox is handed to the shared database queue before canonical persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'layne-event-history-'));
  await writeFile(join(directory, 'input.json'), JSON.stringify({
    event_id: 'local:synthetic:1', event_type: 'layne_task_completed', category: 'layne', source: 'synthetic',
    title: 'Synthetic completion', summary: 'Synthetic test event.', importance: 0.7,
  }));
  const calls = [];
  const store = {
    env: { MONITOR_USER_ID: owner },
    enqueueUnifiedEvents: async events => { calls.push(events); return events.length; },
    api: async () => [],
  };
  const result = await flushUnifiedEventOutbox(store, { directory });
  assert.equal(result.queued, 1);
  assert.equal(result.flushed, 0);
  assert.equal(calls[0][0].event_id, 'local:synthetic:1');
  assert.deepEqual(await readdir(directory), []);
});
