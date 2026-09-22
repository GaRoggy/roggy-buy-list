import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorError, backoff, request, pages, failure } from '../core.mjs';
import { runJob } from '../worker.mjs';

test('retry respects provider delay and is bounded', () => {
  assert.equal(backoff(1, 100, () => 0), 100);
  assert.equal(backoff(30, 999999, () => 0), 86400);
  assert.ok(backoff(3, 0, () => 0.5) > backoff(1, 0, () => 0.5));
});
test('HTTP failures cannot leak provider bodies or tokens', async () => {
  await assert.rejects(request('https://example.invalid', {}, async () => new Response('secret=abc',
    { status: 429, headers: { 'retry-after': '120' } })), e => e.code === 'HTTP_429' && e.retryAfter === 120 && !e.message.includes('abc'));
  assert.equal(failure(new Error('secret')).message, 'UNEXPECTED_ERROR');
});
test('pagination consumes final cursor only after every page', async () => {
  const seen = [];
  const output = await pages(async (_path, params) => {
    seen.push(params); return params.pageToken ? { items: [2], nextSyncToken: 'final' } : { items: [1], nextPageToken: 'p2' };
  }, 'events', { syncToken: 'old' });
  assert.deepEqual(output.items, [1, 2]);
  assert.deepEqual(seen[1], { syncToken: 'old', pageToken: 'p2' });
  assert.equal(output.data.nextSyncToken, 'final');
});
test('collector failure does not commit a cursor and persists sanitized failure', async () => {
  const calls = [];
  const store = { env: {}, rpc: async (name, body) => { calls.push([name, body]); } };
  await runJob(store, { job: { id: 'job', lease_token: 'fence', attempts: 1 }, source: { id: 'source' } },
    async () => { throw new MonitorError('HTTP_503'); }, async () => {});
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'fail');
  assert.equal(calls[0][1].p_code, 'HTTP_503'); assert.equal(calls[0][1].p_token, 'fence');
});
test('successful run commits records and cursor together with fencing token', async () => {
  const calls = [];
  await runJob({ env: {}, rpc: async (name, body) => { calls.push([name, body]); return 1; } },
    { job: { id: 'job', lease_token: 'fence', attempts: 1 }, source: { id: 'source' } },
    async () => ({ records: [{ kind: 'email', external_id: '1' }], cursor: { historyId: '2' } }), async () => {});
  assert.equal(calls[0][0], 'commit'); assert.deepEqual(calls[0][1].p_cursor, { historyId: '2' });
});
