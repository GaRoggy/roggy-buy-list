import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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
async function drainResponseBody(response) {
  if (!response?.body) return;
  try { for await (const _chunk of response.body) {} } catch {}
}
function coreFetch(input, options = {}) {
  const target = new URL(input);
  const transport = target.protocol === 'https:' ? httpsRequest : target.protocol === 'http:' ? httpRequest : null;
  if (!transport) throw new TypeError('Unsupported request protocol');
  const { method = 'GET', headers: requestHeaders = {}, body, signal, redirect = 'error' } = options;
  const headers = { ...requestHeaders };
  // The loopback Python HTTP handlers read a fixed-length body. Node's
  // native request would otherwise send the written JSON as chunked data.
  if (typeof body === 'string' && !Object.keys(headers).some(name =>
    ['content-length', 'transfer-encoding'].includes(name.toLowerCase()))) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const request = transport(target, { method, headers, signal }, response => {
      if (redirect === 'error' && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        reject(new Error('Redirect not allowed'));
        return;
      }
      const wrapped = {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode || 0,
        headers: { get(name) {
          const value = response.headers[String(name).toLowerCase()];
          return value === undefined ? null : Array.isArray(value) ? value.join(', ') : String(value);
        } },
        body: response,
        async text() {
          const chunks = [];
          for await (const chunk of response) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return Buffer.concat(chunks).toString('utf8');
        },
        async json() { return JSON.parse(await this.text()); },
      };
      resolve(wrapped);
    });
    request.once('error', reject);
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
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
const SMART_HOME_PATH = /^\/(?:devices(?:\/[A-Za-z0-9._~%+\-]+(?:\/actions)?)?|rooms(?:\/[A-Za-z0-9._~%+\-]+)?|events\/(?:history|stream)|transcripts\/(?:history|stream))$/;
const GARMIN_WATCH_PREFIX = `${SMART_HOME_PREFIX}/api/garmin`;
const GARMIN_SEGMENT = '(?:[A-Za-z0-9._~+-]|%[0-9A-Fa-f]{2})+';
// App-facing watch routes only; owner administration and the internal transcript relay stay unreachable.
const GARMIN_WATCH_ROUTES = [
  { method: 'POST', pattern: /^\/api\/garmin\/pair$/, operation: 'garmin.pair', query: [] },
  { method: 'POST', pattern: /^\/api\/garmin\/token\/refresh$/, operation: 'garmin.token_refresh', query: [] },
  { method: 'GET', pattern: /^\/api\/garmin\/lights$/, operation: 'garmin.lights_page', query: [] },
  { method: 'GET', pattern: new RegExp(`^/api/garmin/lights/${GARMIN_SEGMENT}$`), operation: 'garmin.light_detail', query: [] },
  { method: 'POST', pattern: new RegExp(`^/api/garmin/lights/${GARMIN_SEGMENT}/actions$`), operation: 'garmin.light_action', query: [] },
  { method: 'GET', pattern: /^\/api\/garmin\/lists$/, operation: 'garmin.lists_page', query: ['collection', 'limit', 'offset'] },
  { method: 'GET', pattern: new RegExp(`^/api/garmin/lists/${GARMIN_SEGMENT}/${GARMIN_SEGMENT}$`), operation: 'garmin.list_detail', query: [] },
  { method: 'POST', pattern: /^\/api\/garmin\/lists$/, operation: 'garmin.list_create', query: [] },
  { method: 'POST', pattern: /^\/api\/garmin\/lists\/actions$/, operation: 'garmin.list_action', query: [] },
  { method: 'GET', pattern: /^\/api\/garmin\/agenda$/, operation: 'garmin.agenda_page', query: ['limit', 'offset'] },
  { method: 'GET', pattern: new RegExp(`^/api/garmin/agenda/${GARMIN_SEGMENT}$`), operation: 'garmin.agenda_detail', query: [] },
  { method: 'POST', pattern: /^\/api\/garmin\/agenda\/actions$/, operation: 'garmin.agenda_action', query: [] },
  { method: 'GET', pattern: /^\/api\/garmin\/front-door$/, operation: 'garmin.front_door_page', query: ['limit', 'offset'] },
  { method: 'GET', pattern: new RegExp(`^/api/garmin/front-door/${GARMIN_SEGMENT}$`), operation: 'garmin.front_door_detail', query: [] },
  { method: 'GET', pattern: /^\/api\/garmin\/transcripts$/, operation: 'garmin.transcript_page', query: ['limit', 'cursor'] },
  { method: 'GET', pattern: new RegExp(`^/api/garmin/transcripts/${GARMIN_SEGMENT}$`), operation: 'garmin.transcript_detail', query: [] },
];
function smartHomeGarminWatchRequest(reqUrl, requestMethod = null) {
  const parsed = new URL(reqUrl, 'http://bridge.local');
  if (parsed.pathname !== GARMIN_WATCH_PREFIX && !parsed.pathname.startsWith(`${GARMIN_WATCH_PREFIX}/`)) return null;
  const path = parsed.pathname.slice(SMART_HOME_PREFIX.length);
  if (/%(?:2f|5c)/i.test(path)) throw new AIError('SMART_HOME_ROUTE_NOT_FOUND', 404);
  const matching = GARMIN_WATCH_ROUTES.filter(candidate => candidate.pattern.test(path));
  if (!matching.length) throw new AIError('SMART_HOME_ROUTE_NOT_FOUND', 404);
  const route = matching.find(candidate => candidate.method === requestMethod);
  if (!route) throw new AIError('METHOD_NOT_ALLOWED', 405);
  const keys = [...parsed.searchParams.keys()];
  if (keys.some(key => !route.query.includes(key)) || new Set(keys).size !== keys.length) {
    throw new AIError('SMART_HOME_QUERY_INVALID', 400);
  }
  for (const key of ['limit', 'offset']) {
    const value = parsed.searchParams.get(key);
    if (value !== null && (!/^\d{1,5}$/.test(value) || Number(value) < (key === 'limit' ? 1 : 0) || Number(value) > (key === 'limit' ? 10 : 10000))) {
      throw new AIError('SMART_HOME_QUERY_INVALID', 400);
    }
  }
  const collection = parsed.searchParams.get('collection');
  if (collection !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(collection)) throw new AIError('SMART_HOME_QUERY_INVALID', 400);
  const cursor = parsed.searchParams.get('cursor');
  if (cursor !== null && (cursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(cursor))) throw new AIError('SMART_HOME_QUERY_INVALID', 400);
  return { kind: 'proxy', method: route.method, path, search: parsed.search, operation: route.operation };
}

const CONFIRMATION_PATH = /^\/confirmations\/[A-Za-z0-9._~%+\-]+$/;
const CAMERA_PREFIX = '/camera';
const CAMERA_SNAPSHOT_NAME = /^front_door_[0-9_-]+\.jpg$/;
const PC_HEALTH_PREFIX = '/pc-health';
const NETWORK_RANGE = new Set(['1h', '6h', '24h', '7d']);
function smartHomeRequest(reqUrl, requestMethod = null) {
  const parsed = new URL(reqUrl, 'http://bridge.local');
  if (!parsed.pathname.startsWith(`${SMART_HOME_PREFIX}/`) && parsed.pathname !== SMART_HOME_PREFIX) return null;
  const path = parsed.pathname.slice(SMART_HOME_PREFIX.length) || '/diagnostics';
  if (path === '/diagnostics') return { kind: 'diagnostics', method: 'GET' };
  if (path === '/commands') return { kind: 'proxy', method: 'POST', path: '/api/commands', search: parsed.search };
  if (path === '/api/voice-settings') {
    if (!['GET', 'POST'].includes(requestMethod)) throw new AIError('METHOD_NOT_ALLOWED', 405);
    return { kind: 'proxy', method: requestMethod, path };
  }
  if (/^\/routines(?:\/[A-Za-z0-9_-]+\/(?:history|runs\/[A-Za-z0-9_-]+|run|cancel))?$/.test(path)) {
    const method = /\/(?:run|cancel)$/.test(path) ? 'POST' : 'GET';
    if (requestMethod !== method) throw new AIError('METHOD_NOT_ALLOWED', 405);
    if ([...parsed.searchParams.keys()].some(k => !['limit', 'offset'].includes(k))) throw new AIError('SMART_HOME_QUERY_INVALID', 400);
    return { kind: 'proxy', method, path: `/api${path}`, search: parsed.search };
  }
  if (CONFIRMATION_PATH.test(path)) {
    if (!['GET', 'POST'].includes(requestMethod)) throw new AIError('METHOD_NOT_ALLOWED', 405);
    return { kind: 'proxy', method: requestMethod, path: `/api${path}`, search: parsed.search };
  }
  if (!SMART_HOME_PATH.test(path)) throw new AIError('SMART_HOME_ROUTE_NOT_FOUND', 404);
  const isAction = path.endsWith('/actions');
  const isStream = path.endsWith('/stream');
  const method = isAction ? 'POST' : 'GET';
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

function pcHealthRequest(reqUrl, requestMethod = null) {
  const parsed = new URL(reqUrl, 'http://bridge.local');
  if (parsed.pathname !== PC_HEALTH_PREFIX && !parsed.pathname.startsWith(`${PC_HEALTH_PREFIX}/`)) return null;
  const path = parsed.pathname.slice(PC_HEALTH_PREFIX.length) || '/';
  if (path === '/codex/stop') {
    if (requestMethod !== 'POST') throw new AIError('METHOD_NOT_ALLOWED', 405);
    if (parsed.search) throw new AIError('PC_HEALTH_ROUTE_NOT_FOUND', 404);
    return { method: 'POST', path: '/internal/pc/codex/stop', search: '', timeoutMs: 10000, action: 'codex_stop' };
  }
  if (requestMethod !== 'GET') throw new AIError('METHOD_NOT_ALLOWED', 405);
  const limitValue = parsed.searchParams.get('limit');
  const limit = limitValue === null ? undefined : Number(limitValue);
  const max = path === '/history' ? 270 : 100;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > max)) {
    throw new AIError('PC_HEALTH_LIMIT_INVALID', 400);
  }
  const routes = {
    '/': { path: '/internal/pc-health', search: '' },
    '/history': { path: '/internal/pc-health/history', search: limit === undefined ? '' : `?limit=${limit}` },
    '/events': { path: '/internal/pc-health/events', search: limit === undefined ? '' : `?limit=${limit}` },
  };
  const route = routes[path];
  if (!route) throw new AIError('PC_HEALTH_ROUTE_NOT_FOUND', 404);
  return { method: 'GET', ...route, timeoutMs: 12000 };
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
  const token = await localAgentToken(cfg);
  const safeProbe = async (url, headers) => {
    try { return { response: await probe(url, headers) }; }
    catch (error) { return { error }; }
  };
  const [statusProbe, voiceProbe, layneProbe] = await Promise.all([
    safeProbe(`${cfg.smartHome}/status`),
    safeProbe(`${cfg.smartHome}/diagnostics/voice`),
    token ? safeProbe(`${cfg.localAgent}/health`, { Authorization: `Bearer ${token}` }) : Promise.resolve({ response: null }),
  ]);
  try {
    const response = statusProbe.response;
    if (!response?.ok) {
      await drainResponseBody(response);
      throw statusProbe.error || new Error(`smart_home_${response?.status || 'unavailable'}`);
    }
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
  try {
    const response = voiceProbe.response;
    if (!response?.ok) {
      await drainResponseBody(response);
      throw voiceProbe.error || new Error(`smart_home_diagnostics_${response?.status || 'unavailable'}`);
    }
    const body = await response.json();
    const bridge = body?.agent_bridge || {}, voice = body?.voice || {}, whisper = voice.whisper || {};
    result.agent_bridge = { configured_microphones: bridge.configured_microphones };
    result.voice = {
      status: voice.status,
      state: voice.state,
      all_audio_streams_healthy: voice.all_audio_streams_healthy,
      microphone_count: voice.microphone_count,
      connected_microphone_count: voice.connected_microphone_count,
      microphones: Array.isArray(voice.microphones) ? voice.microphones.map(microphone => ({
        microphone_id: microphone.microphone_id, friendly_name: microphone.friendly_name,
        room: microphone.room, connected: microphone.connected,
        audio_stream_healthy: microphone.audio_stream_healthy, vad_loaded: microphone.vad_loaded,
        last_audio_age_seconds: microphone.last_audio_age_seconds,
      })) : [],
      whisper: { model: whisper.model, ready: whisper.ready, active_jobs: whisper.active_jobs, queue: whisper.queue },
    };
  } catch {
    result.agent_bridge = { status: 'unavailable' };
    result.voice = { status: 'unavailable' };
  }
  if (!token) result.layne = { status: 'unknown', reason: 'not_configured' };
  else if (layneProbe.response) {
    await drainResponseBody(layneProbe.response);
    result.layne = { status: layneProbe.response.ok ? 'online' : 'offline' };
  } else {
    const error = layneProbe.error;
    const detail = error instanceof AIError ? error.toJSON() : new AIError(
      'LAYNE_UNAVAILABLE', 503, { operation: 'layne.health', cause: error?.name || 'FetchError' },
    ).toJSON();
    result.layne = { status: 'offline', reason: 'network_error', error: detail };
  }
  return result;
}

async function proxySmartHomeStream(req, res, cfg, signal, route) {
  const target = new URL(`${route.path}${route.search || ''}`, `${cfg.smartHome}/`);
  const headers = { Accept: req.headers.accept || 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers['last-event-id']) headers['Last-Event-ID'] = req.headers['last-event-id'];
  await new Promise((resolve, reject) => {
    let responseReceived = false, settled = false, timedOut = false;
    let timeout;
    const upstream = httpRequest(target, { method: route.method, headers });
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const abort = () => {
      upstream.destroy();
      if (!res.destroyed && !res.writableEnded) res.destroy();
      finish();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    timeout = setTimeout(() => {
      timedOut = true;
      upstream.destroy(new Error('SMART_HOME_TIMEOUT'));
    }, 8000);
    upstream.on('response', response => {
      responseReceived = true;
      clearTimeout(timeout);
      res.writeHead(response.statusCode || 502, {
        'Content-Type': response.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'X-Accel-Buffering': 'no',
      });
      response.on('error', error => {
        if (!res.destroyed) res.destroy(error);
        finish();
      });
      response.on('end', () => {
        if (!res.destroyed && !res.writableEnded) res.end();
        finish();
      });
      response.pipe(res);
    });
    upstream.on('error', error => {
      if (settled) return;
      if (responseReceived) {
        if (!res.destroyed) res.destroy(error);
        finish();
        return;
      }
      settled = true;
      cleanup();
      reject(new AIError(timedOut ? 'SMART_HOME_TIMEOUT' : 'SMART_HOME_UNAVAILABLE', timedOut ? 504 : 503, {
        operation: 'smart_home.proxy', cause: error?.name || 'FetchError', retryable: true,
      }));
    });
    upstream.end();
  });
}

async function proxySmartHome(req, res, cfg, fetcher, signal, route) {
  // Node 24.19's bundled Undici can terminate the process if an SSE consumer
  // disconnects while its HTTP/1 parser is paused. Use the core HTTP stream for
  // live feeds so browser disconnects close the loopback request cleanly.
  if (route.stream && fetcher === coreFetch) {
    await proxySmartHomeStream(req, res, cfg, signal, route);
    return;
  }
  const target = new URL(`${route.path}${route.search || ''}`, `${cfg.smartHome}/`);
  const headers = { Accept: req.headers.accept || 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
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
  for await (const chunk of response.body) {
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
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    if (!res.write(chunk)) await once(res, 'drain', { signal });
  }
  res.end();
}

async function proxyPcHealth(req, res, cfg, fetcher, signal, route) {
  const token = await localAgentToken(cfg);
  if (!token) throw new AIError('PC_HEALTH_AUTH_NOT_CONFIGURED', 503, {
    operation: 'pc_health.proxy', retryable: false,
  });
  const target = new URL(`${route.path}${route.search || ''}`, `${cfg.localAgent}/`);
  const connect = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; connect.abort(); }, route.timeoutMs || 12000);
  let response;
  try {
    let body;
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (route.method === 'POST') {
      const input = await readBody(req, signal);
      if (!input || Array.isArray(input) || Object.keys(input).length) throw new AIError('PC_HEALTH_ACTION_BODY_INVALID', 400);
      body = JSON.stringify({});
      headers['Content-Type'] = 'application/json';
    }
    response = await fetcher(target.toString(), {
      method: route.method || 'GET', headers, body,
      redirect: 'error', signal: AbortSignal.any([signal, connect.signal]),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason || error;
    throw new AIError(timedOut ? 'PC_HEALTH_TIMEOUT' : 'PC_HEALTH_UNAVAILABLE', timedOut ? 504 : 503, {
      operation: 'pc_health.proxy', cause: error?.name || 'FetchError', retryable: true,
    });
  } finally { clearTimeout(timer); }
  const payload = await response.json().catch(() => ({}));
  json(res, response.status, payload);
}

export function createBridge(cfg, { fetcher = coreFetch, ai = createAI(cfg, fetcher), logger = row => console.log(JSON.stringify(row)) } = {}) {
  // Fixed-size global buckets avoid attacker-controlled IP/token maps. Forwarded headers are never trusted.
  const ingress = bucket(120), chats = bucket(10), discovery = bucket(30), codexStops = bucket(3);
  let inflight = 0, openStreams = 0, generating = false;
  const active = new Set();
  const server = createServer({ maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 0 }, async (req, res) => {
    const started = Date.now(), id = randomUUID(), controller = new AbortController();
    const { signal } = controller; let timer, heartbeat, ownsGeneration = false, counted = false, countedStream = false, outcome = 'OK', operation = null;
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
      // Smart Home validates paired device credentials. Browser routes require the owner JWT.
      const garminWatch = smartHomeGarminWatchRequest(req.url, req.method);
      const smartHome = garminWatch ? null : smartHomeRequest(req.url, req.method);
      if (smartHome?.stream && smartHome.method === req.method) {
        if (openStreams >= 8) throw new AIError('BUSY', 429);
        openStreams++; countedStream = true;
      } else {
        if (inflight >= 4) throw new AIError('BUSY', 429);
        inflight++; counted = true;
      }
      if (!garminWatch) await authorize(req.headers.authorization, cfg, signal, fetcher);
      signal.throwIfAborted();
      if (garminWatch) {
        operation = garminWatch.operation;
        await proxySmartHome(req, res, cfg, fetcher, signal, garminWatch);
        return;
      }
      const network = networkRequest(req.url, req.method);
      if (network) {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new AIError('NETWORK_TIMEOUT', 504)), 12000);
        await proxyNetwork(res, cfg, fetcher, signal, network);
        return;
      }
      const pcHealth = pcHealthRequest(req.url, req.method);
      if (pcHealth) {
        if (pcHealth.action === 'codex_stop') {
          if (!codexStops()) throw new AIError('RATE_LIMITED', 429);
          operation = 'pc_health_codex_stop';
        }
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new AIError('PC_HEALTH_TIMEOUT', 504)), pcHealth.timeoutMs || 12000);
        await proxyPcHealth(req, res, cfg, fetcher, signal, pcHealth);
        return;
      }
      if (smartHome) {
        if (smartHome.method !== req.method) throw new AIError('METHOD_NOT_ALLOWED', 405);
        operation = smartHome.path ? `smart_home:${smartHome.stream ? 'stream' : smartHome.path === '/api/commands' ? 'command' : 'request'}` : 'smart_home:diagnostics';
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
      if (countedStream) openStreams--;
      // Deliberately exclude URL, headers, owner, model, prompt, response and raw errors.
      logger({ time: new Date().toISOString(), event: 'ai_request', requestId: id, operation, outcome, durationMs: Date.now() - started });
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
