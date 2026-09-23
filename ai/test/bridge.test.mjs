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
    'Access-Control-Request-Headers': 'authorization,content-type', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'https://garoggy.github.io');
  assert.equal(r.headers.get('access-control-allow-private-network'), 'true'); assert.equal(f.calls.length, 0);
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
