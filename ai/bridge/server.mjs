import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { config } from './config.mjs';
import { authorize } from './auth.mjs';
import { createAI } from '../processing.mjs';
import { AIError, LIMITS, validateRequest } from '../shared/protocol.js';
import { acquireProcessLock } from '../shared/single-instance.mjs';

function bucket(limit, windowMs = 60000) {
  let count = 0, reset = 0;
  return () => { const now = Date.now(); if (now >= reset) { count = 0; reset = now + windowMs; } return ++count <= limit; };
}
async function readBody(req, signal) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) throw new AIError('JSON_REQUIRED', 415);
  if (Number(req.headers['content-length']) > LIMITS.bodyBytes) throw new AIError('REQUEST_TOO_LARGE', 413);
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); signal.removeEventListener('abort', abort); };
    const error = e => { cleanup(); reject(e); };
    const abort = () => error(signal.reason);
    const data = chunk => {
      size += chunk.length;
      if (size > LIMITS.bodyBytes) { req.pause(); error(new AIError('REQUEST_TOO_LARGE', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new AIError('INVALID_JSON')); } };
    req.on('data', data); req.on('end', end); req.on('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
function remoteFailure(payload, fallbackCode, fallbackMessage, status, operation) {
  const remote = payload?.error;
  if (remote && typeof remote === 'object') {
    return new AIError(String(remote.error_code || remote.code || fallbackCode), status, {
      message: remote.message || fallbackMessage, operation: remote.operation || operation,
      cause: remote.cause, target: remote.target, retryable: remote.retryable,
      details: remote.details || {},
    });
  }
  return new AIError(typeof remote === 'string' ? remote : fallbackCode, status, { message: fallbackMessage, operation });
}

const SMART_HOME_PREFIX = '/smart-home';
const SMART_HOME_PATH = /^\/(?:devices(?:\/[A-Za-z0-9._~%+\-]+(?:\/actions)?)?|rooms(?:\/[A-Za-z0-9._~%+\-]+)?|events\/(?:history|stream))$/;
const CONFIRMATION_PATH = /^\/confirmations\/[A-Za-z0-9._~%+\-]+$/;
const CAMERA_PREFIX = '/camera';
const CAMERA_SNAPSHOT_NAME = /^front_door_[0-9_-]+\.jpg$/;
const NETWORK_RANGE = new Set(['1h', '6h', '24h', '7d']);
function smartHomeRequest(reqUrl, requestMethod = null) {
  const parsed = new URL(reqUrl, 'http://bridge.local');
  if (!parsed.pathname.startsWith(`${SMART_HOME_PREFIX}/`) && parsed.pathname !== SMART_HOME_PREFIX) return null;
  const path = parsed.pathname.slice(SMART_HOME_PREFIX.length) || '/diagnostics';
  if (path === '/diagnostics') return { kind: 'diagnostics', method: 'GET' };
  if (path === '/commands') return { kind: 'proxy', method: 'POST', path: '/api/commands', search: parsed.search };
  if (CONFIRMATION_PATH.test(path)) {
    if (!['GET', 'POST'].includes(requestMethod)) throw new AIError('METHOD_NOT_ALLOWED', 405);
    return { kind: 'proxy', method: requestMethod, path: `/api${path}`, search: parsed.search };
  }
  if (!SMART_HOME_PATH.test(path)) throw new AIError('SMART_HOME_ROUTE_NOT_FOUND', 404);
  const isAction = path.endsWith('/actions');
  const isStream = path === '/events/stream';
  const method = isAction ? 'POST' : 'GET';
  if (parsed.search && path === '/events/stream') return { kind: 'proxy', method, path: `/api${path}`, search: parsed.search };
  return { kind: 'proxy', method, path: `/api${path}`, search: parsed.search, stream: isStream };
}

function networkRequest(reqUrl, requestMethod = null) {
  const parsed = new URL(reqUrl, 'http://bridge.local');
  if (!parsed.pathname.startsWith('/network/')) return null;
  if (requestMethod !== 'GET') throw new AIError('METHOD_NOT_ALLOWED', 405);
  const path = parsed.pathname.slice('/network'.length);
  const range = parsed.searchParams.get('range') || '24h';
  if (!NETWORK_RANGE.has(range)) throw new AIError('NETWORK_RANGE_INVALID', 400);
  const limitValue = parsed.searchParams.get('limit');
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1200)) {
    throw new AIError('NETWORK_LIMIT_INVALID', 400);
  }
  const routes = {
    '/status': { tool: 'network_get_status', arguments: {} },
    '/summary': { tool: 'network_get_reliability', arguments: { period: range } },
    '/incidents': { tool: 'network_get_incidents', arguments: { period: range, limit: Math.min(limit || 50, 100) } },
    '/measurements': { tool: 'network_get_measurements', arguments: { period: range, limit: limit || 600 } },
  };
  const route = routes[path];
  if (!route) throw new AIError('NETWORK_ROUTE_NOT_FOUND', 404);
  return route;
}

function cameraRequest(reqUrl, requestMethod = null) {
  const parsed = new URL(reqUrl, 'http://bridge.local');
  if (!parsed.pathname.startsWith(`${CAMERA_PREFIX}/`)) return null;
  const path = parsed.pathname.slice(CAMERA_PREFIX.length);
  if (path === '/front-door') {
    if (requestMethod !== 'GET') throw new AIError('METHOD_NOT_ALLOWED', 405);
    return { method: 'GET', path: '/internal/camera/front_door', search: parsed.search, json: true, timeoutMs: 15000 };
  }
  if (path === '/front-door/events') {
    if (requestMethod !== 'GET') throw new AIError('METHOD_NOT_ALLOWED', 405);
    return { method: 'GET', path: '/internal/camera/front_door/events', search: parsed.search, json: true, timeoutMs: 15000 };
  }
  if (path === '/front-door/frame') {
    if (requestMethod !== 'GET') throw new AIError('METHOD_NOT_ALLOWED', 405);
    return { method: 'GET', path: '/internal/camera/front_door/frame', search: parsed.search, json: false, timeoutMs: 15000 };
  }
  if (path === '/front-door/analyze') {
    if (requestMethod !== 'POST') throw new AIError('METHOD_NOT_ALLOWED', 405);
    return { method: 'POST', path: '/internal/camera/front_door/analyze', search: parsed.search, json: true, timeoutMs: 180000 };
  }
  const match = path.match(/^\/front-door\/image\/([^/]+)$/);
  if (match) {
    if (requestMethod !== 'GET') throw new AIError('METHOD_NOT_ALLOWED', 405);
    let name;
    try { name = decodeURIComponent(match[1]); } catch { throw new AIError('CAMERA_ROUTE_NOT_FOUND', 404); }
    if (!CAMERA_SNAPSHOT_NAME.test(name)) throw new AIError('CAMERA_ROUTE_NOT_FOUND', 404);
    return { method: 'GET', path: `/internal/camera/front_door/snapshots/${encodeURIComponent(name)}`, search: parsed.search, json: false, timeoutMs: 15000 };
  }
  throw new AIError('CAMERA_ROUTE_NOT_FOUND', 404);
}

function sanitizeCameraPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeCameraPayload);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'snapshot_directory') continue;
    if (key === 'snapshot_path' || key === 'last_snapshot_path') {
      const snapshotName = String(item || '').split(/[\\/]/).pop() || '';
      if (CAMERA_SNAPSHOT_NAME.test(snapshotName)) clean.snapshot_name = snapshotName;
      continue;
    }
    clean[key] = sanitizeCameraPayload(item);
  }
  return clean;
}

async function localAgentToken(cfg) {
  if (cfg.localAgentApiToken) return cfg.localAgentApiToken;
  try { return (await readFile(cfg.localAgentTokenFile, 'utf8')).trim() || null; } catch { return null; }
}

async function smartHomeDiagnostics(cfg, fetcher, signal) {
  const result = {
    bridge: { status: 'online', transport: 'private_tailscale' },
    authentication: { status: 'authenticated' },
    layne: { status: 'unknown' },
    smart_home: { status: 'offline' },
    devices: []
  };
  const probe = async (url, headers = {}) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 6000);
    try {
      return await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.any([signal, timeout.signal]) });
    } finally { clearTimeout(timer); }
  };
  try {
    const response = await probe(`${cfg.smartHome}/status`);
    if (!response.ok) throw new Error(`smart_home_${response.status}`);
    const body = await response.json();
    result.smart_home = { status: body?.status === 'ok' ? 'online' : 'degraded' };
    result.devices = Array.isArray(body?.devices) ? body.devices.map(device => ({
      device_id: device.device_id,
      friendly_name: device.friendly_name,
      room: device.room,
      type: device.type,
      capabilities: device.capabilities,
      availability: device.availability,
      online: device.online,
      state: device.state,
      freshness: device.freshness,
      last_seen: device.last_seen,
      last_state_changed_at: device.last_state_changed_at
    })) : [];
  } catch (error) {
    const detail = error instanceof AIError ? error.toJSON() : new AIError(
      'SMART_HOME_UNAVAILABLE', 503, { operation: 'smart_home.diagnostics', cause: error?.name || 'FetchError' },
    ).toJSON();
    result.smart_home = { status: 'offline', reason: 'network_error', error: detail };
  }
  const token = await localAgentToken(cfg);
  if (!token) result.layne = { status: 'unknown', reason: 'not_configured' };
  else {
    try {
      const response = await probe(`${cfg.localAgent}/health`, { Authorization: `Bearer ${token}` });
      result.layne = { status: response.ok ? 'online' : 'offline' };
    } catch (error) {
      const detail = error instanceof AIError ? error.toJSON() : new AIError(
        'LAYNE_UNAVAILABLE', 503, { operation: 'layne.health', cause: error?.name || 'FetchError' },
      ).toJSON();
      result.layne = { status: 'offline', reason: 'network_error', error: detail };
    }
  }
  return result;
}

async function proxySmartHome(req, res, cfg, fetcher, signal, route) {
  const target = new URL(`${route.path}${route.search || ''}`, `${cfg.smartHome}/`);
  const headers = { Accept: req.headers.accept || 'application/json', Authorization: req.headers.authorization };
  if (req.headers['last-event-id']) headers['Last-Event-ID'] = req.headers['last-event-id'];
  let body;
  if (route.method === 'POST') {
    body = JSON.stringify(await readBody(req, signal));
    headers['Content-Type'] = 'application/json';
  }
  const connect = new AbortController();
  // Natural-language commands are relayed to LocalAgent's bounded planner;
  // use the same configured budget as the planner instead of the short
  // device-request timeout.
  const timeoutMs = route.path === '/api/commands' ? cfg.timeoutMs : 8000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; connect.abort(); }, timeoutMs);
  let response;
  try {
    response = await fetcher(target.toString(), { method: route.method, headers, body, redirect: 'error', signal: AbortSignal.any([signal, connect.signal]) });
  } catch (error) {
    if (signal.aborted) throw signal.reason || error;
    throw new AIError(timedOut ? 'SMART_HOME_TIMEOUT' : 'SMART_HOME_UNAVAILABLE', timedOut ? 504 : 503, {
      operation: 'smart_home.proxy', cause: error?.name || 'FetchError', retryable: true,
    });
  } finally { clearTimeout(timer); }
  const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
  res.writeHead(response.status, { 'Content-Type': contentType, 'Cache-Control': route.stream ? 'no-cache, no-store' : 'no-store', 'X-Accel-Buffering': 'no' });
  if (!response.body) { res.end(); return; }
  for await (const chunk of Readable.fromWeb(response.body)) {
    signal.throwIfAborted();
    if (!res.write(chunk)) await once(res, 'drain', { signal });
  }
  res.end();
}

async function proxyNetwork(res, cfg, fetcher, signal, route) {
  const token = await localAgentToken(cfg);
  if (!token) throw new AIError('NETWORK_AUTH_NOT_CONFIGURED', 503, {
    operation: 'network_watch.proxy', retryable: false,
  });
  const target = new URL(`/tools/${route.tool}/execute`, `${cfg.localAgent}/`);
  const connect = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; connect.abort(); }, 10000);
  let response;
  try {
    response = await fetcher(target.toString(), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ arguments: route.arguments }),
      redirect: 'error',
      signal: AbortSignal.any([signal, connect.signal]),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason || error;
    throw new AIError(timedOut ? 'NETWORK_TIMEOUT' : 'NETWORK_UNAVAILABLE', timedOut ? 504 : 503, {
      operation: 'network_watch.proxy', cause: error?.name || 'FetchError', retryable: true,
    });
  } finally { clearTimeout(timer); }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw remoteFailure(payload, 'NETWORK_UNAVAILABLE', 'NetworkWatch returned a diagnostic failure.',
      response.status >= 400 ? response.status : 503, 'network_watch.proxy');
  }
  json(res, 200, payload.data || { status: 'UNKNOWN' });
}

async function proxyCamera(req, res, cfg, fetcher, signal, route) {
  const token = await localAgentToken(cfg);
  if (!token) throw new AIError('CAMERA_AUTH_NOT_CONFIGURED', 503, {
    operation: 'camera.proxy', retryable: false,
  });
  const target = new URL(`${route.path}${route.search || ''}`, `${cfg.localAgent}/`);
  const headers = { Accept: req.headers.accept || (route.json ? 'application/json' : 'image/*'), Authorization: `Bearer ${token}` };
  const connect = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; connect.abort(); }, route.timeoutMs || 15000);
  let response;
  try {
    response = await fetcher(target.toString(), { method: route.method || 'GET', headers, redirect: 'error', signal: AbortSignal.any([signal, connect.signal]) });
  } catch (error) {
    if (signal.aborted) throw signal.reason || error;
    throw new AIError(timedOut ? 'CAMERA_TIMEOUT' : 'CAMERA_UNAVAILABLE', timedOut ? 504 : 503, {
      operation: 'camera.proxy', cause: error?.name || 'FetchError', retryable: true,
    });
  } finally { clearTimeout(timer); }
  if (route.json) {
    // JSON camera state is deliberately sanitized before it crosses the
    // bridge; the browser never receives local filesystem paths.
    const body = await response.json().catch(() => ({}));
    json(res, response.status, sanitizeCameraPayload(body));
    return;
  }
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  res.writeHead(response.status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  if (!response.body) { res.end(); return; }
  for await (const chunk of Readable.fromWeb(response.body)) {
    signal.throwIfAborted();
    if (!res.write(chunk)) await once(res, 'drain', { signal });
  }
  res.end();
}

export function createBridge(cfg, { fetcher = fetch, ai = createAI(cfg, fetcher), logger = row => console.log(JSON.stringify(row)) } = {}) {
  // Fixed-size global buckets avoid attacker-controlled IP/token maps. Forwarded headers are never trusted.
  const ingress = bucket(120), chats = bucket(10), discovery = bucket(30);
  let inflight = 0, generating = false;
  const active = new Set();
  const server = createServer({ maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 0 }, async (req, res) => {
    const started = Date.now(), id = randomUUID(), controller = new AbortController();
    const { signal } = controller; let timer, heartbeat, ownsGeneration = false, counted = false, outcome = 'OK';
    active.add(controller);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin'); res.setHeader('X-Request-Id', id);
    res.on('close', () => controller.abort(new AIError('CANCELLED', 499)));
    req.on('aborted', () => controller.abort(new AIError('CANCELLED', 499)));
    timer = setTimeout(() => controller.abort(new AIError('REQUEST_TIMEOUT', 408)), 15000);
    const write = async event => {
      signal.throwIfAborted();
      if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal });
    };
    try {
      if (!cfg.hosts.has(req.headers.host)) throw new AIError('INVALID_HOST', 403);
      const origin = req.headers.origin;
      if (origin && !cfg.origins.has(origin)) throw new AIError('ORIGIN_DENIED', 403);
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      if (!ingress()) throw new AIError('RATE_LIMITED', 429);
      if (req.method === 'OPTIONS') {
        if (!origin || !['GET', 'POST'].includes(req.headers['access-control-request-method'])) throw new AIError('ORIGIN_DENIED', 403);
        const headers = (req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
        if (headers.some(h => !['authorization', 'content-type', 'last-event-id'].includes(h))) throw new AIError('ORIGIN_DENIED', 403);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
        // Private-network preflight is allowed only for the explicit website origin.
        if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Max-Age', '300'); res.writeHead(204); res.end(); return;
      }
      if (inflight >= 4) throw new AIError('BUSY', 429);
      inflight++; counted = true;
      await authorize(req.headers.authorization, cfg, signal, fetcher);
      signal.throwIfAborted();
      const network = networkRequest(req.url, req.method);
      if (network) {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new AIError('NETWORK_TIMEOUT', 504)), 12000);
        await proxyNetwork(res, cfg, fetcher, signal, network);
        return;
      }
      const smartHome = smartHomeRequest(req.url, req.method);
      if (smartHome) {
        if (smartHome.method !== req.method) throw new AIError('METHOD_NOT_ALLOWED', 405);
        if (smartHome.kind === 'diagnostics') {
          json(res, 200, await smartHomeDiagnostics(cfg, fetcher, signal));
        } else {
          if (smartHome.path === '/api/commands') {
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(new AIError('GENERATION_TIMEOUT', 504)), cfg.timeoutMs);
          }
          if (smartHome.stream) clearTimeout(timer);
          await proxySmartHome(req, res, cfg, fetcher, signal, smartHome);
        }
        return;
      }
      const camera = cameraRequest(req.url, req.method);
      if (camera) {
        await proxyCamera(req, res, cfg, fetcher, signal, camera);
        return;
      }
      if (req.url === '/api/models' && req.method === 'GET') {
        if (!discovery()) throw new AIError('RATE_LIMITED', 429);
        json(res, 200, { provider: 'ollama', models: await ai.models(signal) }); return;
      }
      if (req.url !== '/api/chat' || req.method !== 'POST') throw new AIError('NOT_FOUND', 404);
      if (generating) throw new AIError('BUSY', 429);
      if (!chats()) throw new AIError('RATE_LIMITED', 429);
      const input = validateRequest(await readBody(req, signal));
      // Another upload may have finished while this request was being read.
      if (generating) throw new AIError('BUSY', 429);
      generating = ownsGeneration = true;
      clearTimeout(timer); timer = setTimeout(() => controller.abort(new AIError('GENERATION_TIMEOUT', 504)), cfg.timeoutMs);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      // Keep HTTPS proxies alive while the model loads; never buffer heartbeats behind a slow client.
      heartbeat = setInterval(() => { if (!res.destroyed && !res.writableNeedDrain) res.write('{"type":"ping"}\n'); }, 5000);
      for await (const event of ai.chat(input, signal)) await write(event);
      res.end();
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error;
      const safe = failure instanceof AIError ? failure : new AIError('INTERNAL_ERROR', 500, {
        operation: 'bridge.request', cause: failure?.name || 'UnknownError', retryable: false,
      }); outcome = safe.code;
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) {
          if (safe.status === 429) res.setHeader('Retry-After', '60');
          res.setHeader('Connection', 'close');
          json(res, safe.status, { error: safe.code, error_detail: safe.toJSON(id), requestId: id });
        } else res.end(JSON.stringify({ type: 'error', error: safe.code, error_detail: safe.toJSON(id), requestId: id }) + '\n');
      }
    } finally {
      clearTimeout(timer); clearInterval(heartbeat); active.delete(controller);
      controller.abort(); if (ownsGeneration) generating = false; if (counted) inflight--;
      // Deliberately exclude URL, headers, owner, model, prompt, response and raw errors.
      logger({ time: new Date().toISOString(), event: 'ai_request', requestId: id, outcome, durationMs: Date.now() - started });
    }
  });
  server.maxConnections = 32; server.keepAliveTimeout = 5000; server.timeout = cfg.timeoutMs + 15000;
  server.stop = () => { for (const c of active) c.abort(new AIError('BRIDGE_STOPPING', 503)); server.close(); server.closeIdleConnections(); };
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let lock;
  try {
    lock = await acquireProcessLock(new URL('../../logs/ai-bridge.lock', import.meta.url));
    const cfg = config(), server = createBridge(cfg);
    server.on('error', async e => {
      console.error(JSON.stringify({ event: 'bridge_failed', code: e.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'START_FAILED' }));
      process.exitCode = 1;
      await lock?.release();
      lock = null;
    });
    server.on('close', async () => { await lock?.release(); lock = null; });
    server.listen(cfg.port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'bridge_ready', host: '127.0.0.1', port: cfg.port })));
    for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => server.stop());
  } catch (e) {
    await lock?.release();
    console.error(`Bridge configuration: ${e.message}`); process.exitCode = 1;
  }
}
