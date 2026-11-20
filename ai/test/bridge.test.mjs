import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { config } from '../bridge/config.mjs';
import { createBridge } from '../bridge/server.mjs';
import { AIError, readNDJSON, validateRequest } from '../shared/protocol.js';

const owner = '00000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_fixture', OLLAMA_ALLOWED_USER_ID: owner,
  OLLAMA_ALLOWED_ORIGINS: 'https://garoggy.github.io', OLLAMA_BRIDGE_URL: 'https://pc.example.ts.net' };
const input = { provider: 'ollama', model: 'fixture:local', messages: [{ role: 'user', content: 'Synthetic request' }] };
const result = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function fixture(t, opts = {}) {
  const cfg = { ...config(env), ...opts.cfg }, calls = [], logs = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) {
      if (opts.authError) throw Error('secret raw network error');
      if (opts.authDown) return new Response('', { status: 503 });
      const token = options.headers.Authorization;
      if (token === 'Bearer valid') return result({ id: owner });
      if (token === 'Bearer other') return result({ id: 'different-owner' });
      if (token === 'Bearer anonymous') return result({ id: owner, is_anonymous: true });
      return new Response('', { status: 401 });
    }
    if (url.endsWith('/status')) return result({ status: 'ok', devices: [{ device_id: 'fixture_light', friendly_name: 'Fixture Light', room: 'living_room', type: 'light', capabilities: ['power'], availability: 'online', online: true, state: 'on', freshness: 'fresh' }] });
    if (url.endsWith('/health')) return result({ status: 'ok' });
    if(url.endsWith('/api/devices')&&opts.holdDevices)await opts.holdDevices;
    if (url.endsWith('/api/devices')) return result({ devices: [{ device_id: 'fixture_light', friendly_name: 'Fixture Light', room: 'living_room', capabilities: ['power'], availability: 'online', online: true, state: 'on', freshness: 'fresh' }] });
    if (url.endsWith('/api/rooms')) return result({ rooms: [{ room_id: 'living_room', friendly_name: 'Living Room', device_count: 1, online_devices: 1 }] });
    if (url.includes('/api/garmin/')) {
      const target = new URL(url);
      if (target.pathname === '/api/garmin/pair' && options.method === 'POST') {
        return result({ device_id: 'simulator_fixture', access_token: 'paired_fixture_access', refresh_token: 'paired_fixture_refresh' });
      }
      if (target.pathname === '/api/garmin/token/refresh' && options.method === 'POST') {
        return result({ access_token: 'paired_fixture_access_2', refresh_token: 'paired_fixture_refresh_2' });
      }
      if (options.headers.Authorization !== 'Bearer paired_fixture_access') return new Response('', { status: 401 });
      if (target.pathname === '/api/garmin/transcripts') return result({ entries: [], next_cursor: null });
      if (target.pathname === '/api/garmin/lists') return result({ entries: [] });
      if (target.pathname === '/api/garmin/lists/actions') return result({ updated: true });
      if (target.pathname === '/api/garmin/lights') return result({ devices: [] });
      return result({ route: target.pathname });
    }
    if (url.includes('/api/events/history')) return result({ events: [] });
    if (url.endsWith('/internal/camera/front_door')) return result({
      camera_id: 'front_door', camera_name: 'Front Door Cam', snapshot_directory: 'C:\\Codex\\LocalAgent\\data\\camera_snapshots\\front_door',
      last_snapshot_path: 'C:\\Codex\\LocalAgent\\data\\camera_snapshots\\front_door\\front_door_2026-09-30_01-02-03-000000.jpg',
      last_analysis: { snapshot_path: 'C:\\Codex\\LocalAgent\\data\\camera_snapshots\\front_door\\front_door_2026-09-30_01-02-03-000000.jpg' },
    });
    if (url.endsWith('/internal/camera/front_door/analyze')) return result({
      camera_id: 'front_door', camera_name: 'Front Door Cam', location: 'front_door',
      short_description: 'Empty porch scene', full_description: 'No person is clearly visible in the snapshot.',
      snapshot_path: 'C:\\Codex\\LocalAgent\\data\\camera_snapshots\\front_door\\front_door_2026-09-30_01-02-03-000000.jpg',
    });
    if (url.endsWith('/internal/camera/front_door/frame') || url.includes('/internal/camera/front_door/snapshots/')) {
      return new Response(new Uint8Array([255, 216, 255, 217]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (url.endsWith('/tools/network_get_status/execute')) return result({ ok: true, data: {
      status: 'RUNNING', classification: 'NORMAL', current_latency_ms: 18, current_jitter_ms: 2,
      packet_loss_5m_pct: 0, gateway: { online: true }, dns: { online: true },
      internet: { online: true, successes: 3, total: 3 }, last_measurement_at: '2026-10-05T04:00:00Z',
    } });
    if (url.endsWith('/tools/network_get_reliability/execute')) return result({ ok: true, data: {
      status: 'OK', period: '24h', measured_external_availability_pct: 100, average_latency_ms: 18,
      median_latency_ms: 18, p95_latency_ms: 22, external_packet_loss_pct: 0,
      outage_events: 0, degradation_events: 0, measurements: 10, cycles: 2, incidents: [],
    } });
    if (url.endsWith('/tools/network_get_incidents/execute')) return result({ ok: true, data: {
      status: 'OK', period: '24h', count: 0, incidents: [],
    } });
    if (url.endsWith('/tools/network_get_measurements/execute')) return result({ ok: true, data: {
      status: 'OK', period: '24h', measurement_count: 2, truncated: false, jitter_method: 'fixture',
      summary: { average_latency_ms: 18, average_jitter_ms: 2, average_packet_loss_pct: 0 },
      measurements: [{ timestamp: '2026-10-05T04:00:00Z', latency_ms: 18, jitter_ms: 2, packet_loss_pct: 0 }],
    } });
    if (url.endsWith('/internal/pc/codex/stop')) return result({
      request_accepted: true, status: 'stopped', timestamp: '2026-10-05T04:01:00Z',
      window_found: true, active_prompt_found: true, stop_control_found: true,
      stop_invoked: true, stop_actions: 1, verified_no_active_work: true,
      verified_stopped: true, codex_left_open: true, resumable: true, failure_reason: null,
    });
    if (url.endsWith('/internal/pc-health')) return result({ status: 'healthy', healthState: 'GREEN', timestamp: '2026-10-05T04:00:00Z', stale: false,
      memory: { usedGb: 20.1, totalGb: 31.7, percent: 63.4 }, heavyWork: { allowed: true, decision: 'allow', reasons: [] } });
    if (url.includes('/internal/pc-health/history')) return result({ samples: [{ timestamp: '2026-10-05T04:00:00Z', cpuPercent: 18, ramPercent: 63.4 }], sampleIntervalSeconds: 7, windowMinutes: 30 });
    if (url.includes('/internal/pc-health/events')) return result({ events: [], count: 0 });
    if (url.endsWith('/api/commands')) return result({ message: 'Layne command accepted' });
    if (url.includes('/api/completions')) return result({items:[{id:'completion-fixture',title:'Fixture task completed'}],cursor:1});
    if (url.endsWith('/api/devices/fixture_light/actions')) return result({ success: true });
    if (url.includes('/api/lights/')) return result({success:true,accepted:true,revision:1,entries:[],devices:[]});
    if (opts.offline) throw Error('sensitive Ollama detail');
    if (url.endsWith('/api/tags')) return result({ models: [{ name: 'fixture:local' }, { name: 'remote:cloud' }, { name: 'hidden:alias', remote_model: 'remote' }] });
    if (url.endsWith('/api/show')) return result(opts.remote ? { remote_host: 'https://ollama.com' } : {});
    if (url.endsWith('/api/chat')) {
      if (opts.modelError) return new Response('sensitive stack', { status: 500 });
      if (opts.stall) return new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true }); } }));
      return new Response('{"message":{"content":"Hello 🌎"},"done":false}\n' + (opts.truncated ? '' : '{"message":{"content":"!"},"done":true}\n'));
    }
    throw Error('Unexpected outbound call');
  };
  const server = createBridge(cfg, { fetcher, logger: row => logs.push(row) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`; cfg.hosts.add(new URL(url).host);
  t.after(() => { server.stop(); server.closeAllConnections(); });
  const request = (path = '/api/chat', body = input, token = 'valid', extra = {}) => fetch(url + path, {
    method: body === null ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: 'https://garoggy.github.io', ...(body !== null ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body === null ? undefined : JSON.stringify(body) });
  return { cfg, calls, logs, url, request, server };
}

test('batched light routes preserve owner auth and support sustained live gestures independently of snapshot requests',async t=>{
  const f=await fixture(t),body={updates:[{device_id:'fixture_light',power:'on'}]};
  assert.equal((await f.request('/smart-home/lights/actions',body,'')).status,401);
  assert.equal((await f.request('/smart-home/lights/actions',body,'other')).status,403);
  assert.equal((await f.request('/smart-home/lights/actions',null)).status,405);
  assert.equal((await f.request('/smart-home/lights/status',body)).status,405);
  assert.equal((await f.request('/smart-home/lights/status?arbitrary=yes',null)).status,400);
  // A 25-second gesture can exceed the ordinary bridge's 120-request bucket.
  for(let n=0;n<130;n++)assert.equal((await f.request('/smart-home/lights/actions',body)).status,200);
  assert.equal((await f.request('/smart-home/devices',null)).status,200);
  assert.equal((await f.request('/smart-home/lights/status?device_ids=fixture_light',null)).status,200);
  assert.ok(f.calls.some(c=>c.url.endsWith('/api/lights/actions')));
});

test('light delivery retains reserved capacity while four ordinary requests are active',async t=>{
  let release;const holdDevices=new Promise(r=>release=r),f=await fixture(t,{holdDevices});
  const held=Array.from({length:4},()=>f.request('/smart-home/devices',null));
  try{
    for(let n=0;n<100&&f.calls.filter(c=>c.url.endsWith('/api/devices')).length<4;n++)await new Promise(r=>setTimeout(r,5));
    assert.equal(f.calls.filter(c=>c.url.endsWith('/api/devices')).length,4);
    assert.equal((await f.request('/smart-home/lights/actions',{updates:[{device_id:'fixture_light',power:'off'}]})).status,200);
  }finally{release();await Promise.all(held);}
});
test('configuration rejects privileged keys, non-loopback Ollama, wildcard origins and missing owner', () => {
  for (const change of [{ SUPABASE_ANON_KEY: 'sb_secret_private' }, { SUPABASE_ANON_KEY: `eyJ.${Buffer.from('{"role":"service_role"}').toString('base64url')}.sig` },
    { OLLAMA_BASE_URL: 'https://ollama.com' }, { OLLAMA_BASE_URL: 'http://192.168.1.1:11434' }, { OLLAMA_BASE_URL: 'http://localhost:11434/foo' },
    { OLLAMA_ALLOWED_ORIGINS: '*' }, { OLLAMA_ALLOWED_USER_ID: '' }]) assert.throws(() => config({ ...env, ...change }));
});
test('no bearer, forged/expired bearer, wrong owner and anonymous users cannot access any AI route', async t => {
  const f = await fixture(t);
  for (const [token, status] of [['', 401], ['forged', 401], ['other', 403], ['anonymous', 403]]) {
    for (const [path, body] of [['/api/chat', input], ['/api/models', null]]) assert.equal((await f.request(path, body, token)).status, status);
  }
  assert.equal(f.calls.filter(c => c.url.includes('127.0.0.1')).length, 0);
});
test('authentication outage fails closed without leaking the underlying error', async t => {
  const f = await fixture(t, { authError: true }); const r = await f.request();
  assert.equal(r.status, 503); assert.equal((await r.json()).error, 'AUTH_UNAVAILABLE');
  assert.equal(f.calls.length, 1);
});
test('owner model discovery excludes cloud models and is never cached', async t => {
  const f = await fixture(t), r = await f.request('/api/models', null);
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await r.json()).models.map(m => m.id), ['fixture:local']);
  assert.equal(f.calls[0].options.headers.apikey, env.SUPABASE_ANON_KEY);
  assert.equal(f.calls[0].options.redirect, 'error');
});
test('authenticated conversation goes through HTTP chat API with history, normalized streaming, bounded options, and private logs', async t => {
  const f = await fixture(t); const body = { ...input, messages: [...input.messages, { role: 'assistant', content: 'Previous answer' }, { role: 'user', content: 'Follow up' }] };
  const r = await f.request('/api/chat', body); assert.equal(r.status, 200);
  const stream = []; for await (const event of readNDJSON(r.body)) stream.push(event);
  assert.deepEqual(stream, [{ type: 'delta', text: 'Hello 🌎' }, { type: 'delta', text: '!' }, { type: 'done', reason: 'stop' }]);
  const forwarded = JSON.parse(f.calls.find(c => c.url.endsWith('/api/chat')).options.body);
  assert.deepEqual(forwarded.messages, body.messages); assert.equal(forwarded.stream, true); assert.equal(forwarded.options.num_predict, 2048);
  assert.ok(f.calls.filter(c => !c.url.includes('supabase')).every(c => !c.options.headers.Authorization));
  assert.ok(!JSON.stringify(f.logs).includes('Follow up')); assert.ok(!JSON.stringify(f.logs).includes('valid'));
});
test('request schema prevents system prompts, tools, URLs, extra fields and oversized messages', () => {
  for (const body of [{ ...input, provider: 'openai' }, { ...input, model: '' }, { ...input, url: 'http://evil' },
    { ...input, messages: [{ role: 'system', content: 'x' }] }, { ...input, messages: [{ role: 'user', content: 'x', images: ['a'] }] },
    { ...input, messages: [{ role: 'user', content: 'x'.repeat(12001) }] }, { ...input, messages: [] },
    { ...input, messages: [{ role: 'assistant', content: 'x' }] }]) assert.throws(() => validateRequest(body));
});
test('HTTP size/content-type/schema checks reject before contacting Ollama', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/chat', { ...input, bad: true })).status, 400);
  assert.equal((await f.request('/api/chat', input, 'valid', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/api/chat', { data: 'x'.repeat(70000) })).status, 413);
  assert.equal(f.calls.filter(c => c.url.includes('127.0.0.1')).length, 0);
});
test('origin and DNS-rebinding host checks and private-network preflight', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/models', null, 'valid', { Origin: 'https://evil.test' })).status, 403);
  const rebound = await new Promise(resolve => {
    const req = http.request(new URL(f.url + '/api/models'), { headers: { Host: 'evil.test', Origin: 'https://garoggy.github.io', Authorization: 'Bearer valid' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.end();
  });
  assert.equal(rebound, 403);
  const r = await fetch(f.url + '/api/chat', { method: 'OPTIONS', headers: { Origin: 'https://garoggy.github.io', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type,last-event-id', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'https://garoggy.github.io');
  assert.match(r.headers.get('access-control-allow-headers'), /Last-Event-ID/);
  assert.equal(r.headers.get('access-control-allow-private-network'), 'true'); assert.equal(f.calls.length, 0);
});
test('authenticated smart-home traffic stays behind the owner bridge', async t => {
  const f = await fixture(t, { cfg: { localAgentApiToken: 'agent-fixture' } });
  const diagnostics = await f.request('/smart-home/diagnostics', null);
  assert.equal(diagnostics.status, 200);
  const diagnosticBody = await diagnostics.json();
  assert.equal(diagnosticBody.bridge.status, 'online');
  assert.equal(diagnosticBody.authentication.status, 'authenticated');
  assert.equal(diagnosticBody.smart_home.status, 'online');
  assert.equal(diagnosticBody.layne.status, 'online');
  const devices = await f.request('/smart-home/devices', null);
  assert.equal(devices.status, 200);
  assert.equal((await devices.json()).devices[0].device_id, 'fixture_light');
  const upstream = f.calls.find(call => call.url.endsWith('/api/devices'));
  assert.equal(upstream.options.headers.Authorization, 'Bearer valid');
  assert.equal((await f.request('/smart-home/commands', { text: 'status' })).status, 200);
  assert.equal((await f.request('/smart-home/devices/fixture_light/actions', { action: 'power', value: 'off' })).status, 200);
});
test('completion history stays owner-only and only supports bounded read routes', async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/smart-home/completions?limit=50',null,'')).status,401);
  assert.equal((await f.request('/smart-home/completions?limit=50',null,'other')).status,403);
  const response=await f.request('/smart-home/completions?limit=50&before=3',null);
  assert.equal(response.status,200);assert.equal((await response.json()).items[0].id,'completion-fixture');
  assert.equal((await f.request('/smart-home/completions',{})).status,405);
  assert.equal((await f.request('/smart-home/completions?source=unbounded',null)).status,400);
  assert.equal((await f.request('/smart-home/completions?before=-1',null)).status,400);
  assert.ok(f.calls.some(c=>c.url.includes('/api/completions?limit=50&before=3')));
});
test('native proxy delivers fixed-length command JSON while transcript streams stay open', async t => {
  const body = { text: 'Layne, turn off the alarm 🔕' };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/auth/v1/user') {
      res.end(JSON.stringify({ id: owner }));
    } else if (req.url === '/api/transcripts/stream?last_event_id=sample') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const valid = req.url === '/api/commands' && req.method === 'POST' &&
        Number(req.headers['content-length']) === bytes.length &&
        !req.headers['transfer-encoding'] && bytes.toString() === JSON.stringify(body);
      res.writeHead(valid ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid }));
    }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const cfg = { ...config(env), supabase: target, smartHome: target };
  const bridge = createBridge(cfg, { logger: () => {} });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const url = `http://127.0.0.1:${bridge.address().port}`;
  cfg.hosts.add(new URL(url).host);
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    bridge.stop(); bridge.closeAllConnections();
    upstream.close(); upstream.closeAllConnections();
  });
  const headers = { Authorization: 'Bearer valid' };
  const streams = await Promise.all(Array.from({ length: 4 }, () =>
    fetch(url + '/smart-home/transcripts/stream?last_event_id=sample', { headers, signal: controller.signal })));
  for (const stream of streams) assert.equal(stream.status, 200);
  const response = await fetch(url + '/smart-home/commands', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { valid: true });
});
test('Garmin watch routes use the strict bridge allowlist and paired credentials', async t => {
  const f = await fixture(t);
  const pair = await f.request('/smart-home/api/garmin/pair', { code: 'fixture-code', device_name: 'simulator' }, null);
  assert.equal(pair.status, 200);
  const pairCall = f.calls.find(call => call.url.endsWith('/api/garmin/pair'));
  assert.equal(pairCall.options.method, 'POST');
  assert.equal(pairCall.options.headers.Authorization, undefined);
  assert.equal(pairCall.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(pairCall.options.body), { code: 'fixture-code', device_name: 'simulator' });
  const refresh = await f.request('/smart-home/api/garmin/token/refresh', { refresh_token: 'fixture-refresh' }, null);
  assert.equal(refresh.status, 200);
  const refreshCall = f.calls.find(call => call.url.endsWith('/api/garmin/token/refresh'));
  assert.equal(refreshCall.options.method, 'POST');
  assert.equal(refreshCall.options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(refreshCall.options.body), { refresh_token: 'fixture-refresh' });
  const metadata = await f.request('/smart-home/api/garmin/transcripts?limit=10&cursor=next_cursor', null, 'paired_fixture_access');
  assert.equal(metadata.status, 200);
  const transcriptCall = f.calls.find(call => call.url.includes('/api/garmin/transcripts?'));
  assert.equal(transcriptCall.options.headers.Authorization, 'Bearer paired_fixture_access');
  assert.equal(transcriptCall.options.headers['Content-Type'], undefined);
  assert.equal(new URL(transcriptCall.url).searchParams.get('limit'), '10');
  assert.equal(new URL(transcriptCall.url).searchParams.get('cursor'), 'next_cursor');
  const readCases = [
    ['/smart-home/api/garmin/lights', '/api/garmin/lights'],
    ['/smart-home/api/garmin/lights/light-1', '/api/garmin/lights/light-1'],
    ['/smart-home/api/garmin/lists?collection=tasks&limit=5&offset=0', '/api/garmin/lists'],
    ['/smart-home/api/garmin/lists/tasks/task-1', '/api/garmin/lists/tasks/task-1'],
    ['/smart-home/api/garmin/agenda?limit=4&offset=0', '/api/garmin/agenda'],
    ['/smart-home/api/garmin/agenda/reminder-1', '/api/garmin/agenda/reminder-1'],
    ['/smart-home/api/garmin/front-door?limit=4&offset=0', '/api/garmin/front-door'],
    ['/smart-home/api/garmin/front-door/event-1', '/api/garmin/front-door/event-1'],
    ['/smart-home/api/garmin/transcripts/event-1', '/api/garmin/transcripts/event-1'],
  ];
  for (const [path, targetPath] of readCases) {
    const response = await f.request(path, null, 'paired_fixture_access');
    assert.equal(response.status, 200, path);
    assert.equal(new URL(f.calls.at(-1).url).pathname, targetPath);
  }
  const denied = await f.request('/smart-home/api/garmin/transcripts?limit=10', null, null);
  assert.equal(denied.status, 401);
  assert.equal(f.calls.filter(call => call.url.endsWith('/auth/v1/user')).length, 0);

  const listAction = await f.request('/smart-home/api/garmin/lists/actions', { collection: 'tasks', id: 'task-1', action: 'status' }, 'paired_fixture_access');
  assert.equal(listAction.status, 200);
  const actionCall = f.calls.find(call => call.url.endsWith('/api/garmin/lists/actions'));
  assert.equal(actionCall.options.headers.Authorization, 'Bearer paired_fixture_access');
  assert.deepEqual(JSON.parse(actionCall.options.body), { collection: 'tasks', id: 'task-1', action: 'status' });
  const mutationCases = [
    ['/smart-home/api/garmin/lights/light-1/actions', { action: 'increase_brightness', step: 10 }, '/api/garmin/lights/light-1/actions'],
    ['/smart-home/api/garmin/lists', { collection: 'tasks', title: 'Fixture task' }, '/api/garmin/lists'],
    ['/smart-home/api/garmin/agenda/actions', { id: 'reminder-1', action: 'complete' }, '/api/garmin/agenda/actions'],
  ];
  for (const [path, body, targetPath] of mutationCases) {
    const response = await f.request(path, body, 'paired_fixture_access');
    assert.equal(response.status, 200, path);
    const upstream = f.calls.at(-1);
    assert.equal(upstream.options.method, 'POST');
    assert.equal(upstream.options.headers.Authorization, 'Bearer paired_fixture_access');
    assert.equal(new URL(upstream.url).pathname, targetPath);
  }
  const before = f.calls.filter(call => call.url.includes('/api/garmin/')).length;
  assert.equal((await f.request('/smart-home/api/garmin/transcripts', { unexpected: true }, 'paired_fixture_access')).status, 405);
  assert.equal((await f.request('/smart-home/api/garmin/lists?collection=tasks&limit=999', null, 'paired_fixture_access')).status, 400);
  assert.equal((await f.request('/smart-home/api/garmin/lists?collection=tasks&offset=0&offset=1', null, 'paired_fixture_access')).status, 400);
  assert.equal((await f.request('/smart-home/api/garmin/transcripts/private%2Fid', null, 'paired_fixture_access')).status, 404);
  assert.equal((await f.request('/smart-home/api/garmin/lights/device%ZZ', null, 'paired_fixture_access')).status, 404);
  assert.equal((await f.request('/smart-home/api/garmin/admin/devices', null, 'paired_fixture_access')).status, 404);
  assert.equal(f.calls.filter(call => call.url.includes('/api/garmin/')).length, before);

  assert.equal((await f.request('/smart-home/devices', null, null)).status, 401);
});
test('authenticated network traffic stays behind the owner bridge and exposes safe data only', async t => {
  const f = await fixture(t, { cfg: { localAgentApiToken: 'agent-fixture' } });
  const status = await f.request('/network/status', null);
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.classification, 'NORMAL');
  assert.equal('database_path' in statusBody, false);
  const summary = await f.request('/network/summary?range=24h', null);
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).period, '24h');
  const measurements = await f.request('/network/measurements?range=6h&limit=10', null);
  assert.equal(measurements.status, 200);
  assert.equal((await measurements.json()).jitter_method, 'fixture');
  assert.equal((await f.request('/network/summary?range=30d', null)).status, 400);
  const upstream = f.calls.find(call => call.url.endsWith('/tools/network_get_status/execute'));
  assert.equal(upstream.options.headers.Authorization, 'Bearer agent-fixture');
  assert.equal(JSON.parse(upstream.options.body).arguments && 'database_path' in JSON.parse(upstream.options.body).arguments, false);
});
test('authenticated PC health traffic is read-only and uses the local-agent token', async t => {
  const f = await fixture(t, { cfg: { localAgentApiToken: 'agent-fixture' } });
  const current = await f.request('/pc-health', null);
  assert.equal(current.status, 200);
  assert.equal((await current.json()).healthState, 'GREEN');
  assert.equal((await f.request('/pc-health/history?limit=10', null)).status, 200);
  assert.equal((await f.request('/pc-health/events?limit=10', null)).status, 200);
  assert.equal((await f.request('/pc-health/history?limit=999', null)).status, 400);
  const upstream = f.calls.find(call => call.url.endsWith('/internal/pc-health'));
  assert.equal(upstream.options.headers.Authorization, 'Bearer agent-fixture');
  assert.equal((await f.request('/pc-health', input, 'valid')).status, 405);
});
test('Codex stop is a narrowly scoped authenticated POST and returns verified state', async t => {
  const f = await fixture(t, { cfg: { localAgentApiToken: 'agent-fixture' } });
  const response = await f.request('/pc-health/codex/stop', {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.verified_stopped, true);
  const upstream = f.calls.find(call => call.url.endsWith('/internal/pc/codex/stop'));
  assert.equal(upstream.options.method, 'POST');
  assert.equal(upstream.options.headers.Authorization, 'Bearer agent-fixture');
  assert.deepEqual(JSON.parse(upstream.options.body), {});
  assert.equal((await f.request('/pc-health/codex/stop', null)).status, 405);
  assert.equal((await f.request('/pc-health/codex/stop', {}, '')).status, 401);
  assert.equal((await f.request('/pc-health/codex/stop?x=1', {})).status, 404);
});
test('camera traffic uses the local-agent token and strips filesystem paths', async t => {
  const f = await fixture(t, { cfg: { localAgentApiToken: 'agent-fixture' } });
  const state = await f.request('/camera/front-door', null);
  assert.equal(state.status, 200);
  const body = await state.json();
  assert.equal(body.camera_id, 'front_door');
  assert.equal('snapshot_directory' in body, false);
  assert.equal('last_snapshot_path' in body, false);
  assert.equal('snapshot_path' in body.last_analysis, false);
  const stateCall = f.calls.find(call => call.url.endsWith('/internal/camera/front_door'));
  assert.equal(stateCall.options.headers.Authorization, 'Bearer agent-fixture');
  const frame = await f.request('/camera/front-door/frame', null);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await frame.arrayBuffer())], [255, 216, 255, 217]);
  assert.equal((await f.request('/camera/front-door/image/front_door_2026-09-30_01-02-03-000000.jpg', null)).status, 200);
  assert.equal((await f.request('/camera/front-door/image/%2E%2E%2Fevil.jpg', null)).status, 404);
  const analysis = await fetch(f.url + '/camera/front-door/analyze', {
    method: 'POST', headers: { Authorization: 'Bearer valid', Origin: 'https://garoggy.github.io' },
  });
  assert.equal(analysis.status, 200);
  const analysisBody = await analysis.json();
  assert.equal(analysisBody.short_description, 'Empty porch scene');
  assert.equal('snapshot_path' in analysisBody, false);
  const analysisCall = f.calls.find(call => call.url.endsWith('/internal/camera/front_door/analyze'));
  assert.equal(analysisCall.options.method, 'POST');
  assert.equal(analysisCall.options.headers.Authorization, 'Bearer agent-fixture');
  assert.equal((await f.request('/camera/front-door/analyze', null)).status, 405);
});
test('offline Ollama and model failure return safe errors', async t => {
  const f = await fixture(t, { offline: true }); const r = await f.request('/api/models', null);
  assert.equal(r.status, 503); assert.equal((await r.json()).error, 'OLLAMA_OFFLINE');
  const g = await fixture(t, { modelError: true }); assert.match(await (await g.request()).text(), /MODEL_ERROR/);
});
test('remote model aliases and nonexistent models cannot generate', async t => {
  const f = await fixture(t, { remote: true }); assert.match(await (await f.request()).text(), /LOCAL_MODELS_ONLY/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/api/chat')).length, 0);
  const g = await fixture(t); assert.match(await (await g.request('/api/chat', { ...input, model: 'unknown' })).text(), /MODEL_UNAVAILABLE/);
});
test('truncated stream is reported as incomplete', async t => {
  const f = await fixture(t, { truncated: true }); assert.match(await (await f.request()).text(), /INCOMPLETE_RESPONSE/);
});
test('generation has a deadline and releases the concurrency slot', async t => {
  const f = await fixture(t, { stall: true, cfg: { timeoutMs: 60 } });
  assert.match(await (await f.request()).text(), /GENERATION_TIMEOUT/);
  assert.equal((await f.request('/api/models', null)).status, 200);
});
test('one generation at a time and disconnect cancels upstream', async t => {
  const f = await fixture(t, { stall: true }); const response = await f.request();
  assert.equal((await f.request()).status, 429);
  // Consume until the upstream call has started, then disconnect the client.
  for (let i = 0; i < 50 && !f.calls.some(c => c.url.endsWith('/api/chat')); i++) await new Promise(r => setTimeout(r, 10));
  await response.body.cancel();
  const upstream = f.calls.find(c => c.url.endsWith('/api/chat'));
  for (let i = 0; i < 50 && !upstream.options.signal.aborted; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(upstream.options.signal.aborted, true);
});
test('discovery rate limits apply across refreshed bearer tokens', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) { const r = await f.request('/api/models', null); assert.equal(r.status, 200); await r.text(); }
  const r = await f.request('/api/models', null); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60');
});
test('NDJSON decoder preserves split Unicode and rejects malformed/oversized lines', async () => {
  const bytes = new TextEncoder().encode('{"text":"🌎"}\n{"type":"done"}');
  const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  const out = []; for await (const item of readNDJSON(body)) out.push(item);
  assert.deepEqual(out, [{ text: '🌎' }, { type: 'done' }]);
  await assert.rejects(async () => { for await (const unused of readNDJSON(new Response('invalid\n').body)) {} }, AIError);
  await assert.rejects(async () => { for await (const unused of readNDJSON(new Response('x'.repeat(100)).body, 10)) {} }, AIError);
});
