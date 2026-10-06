import webpush from 'npm:web-push@3.6.7';

type Json = Record<string, unknown>;
type User = { id: string };
type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  enabled: boolean;
  failure_count: number;
  last_success_at?: string | null;
  updated_at?: string | null;
};

class PushError extends Error {
  code: string;
  status: number;
  operation: string | null;
  cause: string | null;
  retryable: boolean;
  details: Record<string, unknown>;
  constructor(code: string, status = 500, options: {
    message?: string; operation?: string; cause?: unknown; retryable?: boolean;
    details?: Record<string, unknown>;
  } = {}) {
    super(options.message || code.replaceAll('_', ' ').toLowerCase());
    this.code = code; this.status = status; this.operation = options.operation || null;
    this.cause = bounded(options.cause, 512);
    this.retryable = options.retryable ?? (status === 408 || status === 429 || status >= 500);
    this.details = options.details || {};
  }
  toJSON(requestId: string | null = null) {
    return { error_code: this.code, code: this.code, subsystem: 'push_notifications', operation: this.operation,
      message: this.message, cause: this.cause, status_code: this.status, target: null,
      retryable: this.retryable, timestamp: new Date().toISOString(), correlation_id: requestId,
      details: this.details };
  }
}
function bounded(value: unknown, limit = 1024): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 14).trimEnd()}… [truncated]`;
}

const PROJECT_ORIGIN = 'https://garoggy.github.io';
const json = (body: Json, status = 200, origin = PROJECT_ORIGIN) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'Origin',
  },
});

function env(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new PushError(`MISSING_${name}`, 503);
  return value;
}

function pushConfiguration(): { subject: string; publicKey: string; privateKey: string } {
  try {
    const subject = env('VAPID_SUBJECT');
    const publicKey = env('VAPID_PUBLIC_KEY');
    const privateKey = env('VAPID_PRIVATE_KEY');
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return { subject, publicKey, privateKey };
  } catch (error) {
    const missing = error instanceof PushError && error.code.startsWith('MISSING_VAPID_');
    throw new PushError(missing ? 'PUSH_CONFIGURATION_MISSING' : 'PUSH_CONFIGURATION_INVALID', 503, {
      operation: 'push.config',
      cause: error instanceof Error ? error.name : 'ConfigurationError',
      retryable: false,
    });
  }
}

function safeProviderBody(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return bounded(String(value)
    .replace(/https?:\/\/\S+/gi, '[url redacted]')
    .replace(/(authorization|token|secret|private[_ -]?key)\s*[:=]\s*[^,\s]+/gi, '$1=[redacted]'));
}

function providerStatusCode(error: unknown): number {
  const candidate = error as { statusCode?: unknown; status?: unknown };
  const status = Number(candidate?.statusCode ?? candidate?.status ?? 0);
  return Number.isInteger(status) ? status : 0;
}

function providerError(error: unknown, subscription: PushSubscriptionRow): PushError {
  const status = providerStatusCode(error);
  const name = error instanceof Error ? error.name : 'ProviderError';
  const body = safeProviderBody((error as { body?: unknown })?.body);
  const details = {
    provider_status: status || null,
    provider_body: body,
    exception_type: name,
    subscription_endpoint: safeEndpointLog(subscription.endpoint),
  };
  if (status === 404 || status === 410) return new PushError('PUSH_SUBSCRIPTION_EXPIRED', 410, {
    message: 'The push provider rejected this subscription as expired.', operation: 'push.send',
    cause: `${name}${status ? ` (${status})` : ''}`, retryable: false, details,
  });
  if (status === 401 || status === 403) return new PushError('PUSH_AUTH_REJECTED', 502, {
    message: 'The push provider rejected Layne authentication credentials.', operation: 'push.send',
    cause: `${name}${status ? ` (${status})` : ''}`, retryable: false, details,
  });
  if (status === 400 || status === 422) return new PushError('PUSH_SUBSCRIPTION_INVALID', 502, {
    message: 'The push provider rejected this subscription as invalid.', operation: 'push.send',
    cause: `${name}${status ? ` (${status})` : ''}`, retryable: false, details,
  });
  if (name === 'TimeoutError' || name === 'AbortError') return new PushError('PUSH_PROVIDER_TIMEOUT', 504, {
    message: 'The push provider timed out before accepting the notification.', operation: 'push.send',
    cause: name, retryable: true, details,
  });
  return new PushError('PUSH_PROVIDER_ERROR', 502, {
    message: 'The push provider rejected the notification.', operation: 'push.send',
    cause: `${name}${status ? ` (${status})` : ''}`, retryable: status >= 500 || status === 0, details,
  });
}

function groupedKey(groupedName: string, legacyName: string): string {
  const grouped = Deno.env.get(groupedName)?.trim();
  if (grouped) {
    try {
      const parsed = JSON.parse(grouped);
      if (typeof parsed.default === 'string' && parsed.default) return parsed.default;
    } catch {}
  }
  return env(legacyName);
}

function supabaseUrl(): string { return env('SUPABASE_URL').replace(/\/$/, ''); }
function publicKey(): string {
  return groupedKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
}

function databaseHeaders(): Record<string, string> {
  const grouped = Deno.env.get('SUPABASE_SECRET_KEYS')?.trim();
  if (grouped) {
    try {
      const parsed = JSON.parse(grouped);
      if (typeof parsed.default === 'string' && parsed.default) {
        return { apikey: parsed.default, 'content-type': 'application/json' };
      }
    } catch {}
  }
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: legacy, authorization: `Bearer ${legacy}`, 'content-type': 'application/json' };
}

function originFor(req: Request): string {
  const origin = req.headers.get('origin') || PROJECT_ORIGIN;
  if (origin !== PROJECT_ORIGIN) throw new PushError('ORIGIN_NOT_ALLOWED', 403);
  return origin;
}

async function readBody(req: Request): Promise<Json> {
  const raw = await req.text();
  if (raw.length > 32768) throw new PushError('REQUEST_TOO_LARGE', 413);
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Json;
  } catch {
    throw new PushError('INVALID_JSON', 400);
  }
}

async function authenticatedUser(req: Request): Promise<User> {
  const authorization = req.headers.get('authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length > 4096) throw new PushError('AUTHENTICATION_REQUIRED', 401);
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
      signal: AbortSignal.timeout(10000),
      headers: { apikey: publicKey(), authorization: `Bearer ${token}` },
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new PushError(timeout ? 'AUTHENTICATION_TIMEOUT' : 'AUTHENTICATION_UNAVAILABLE', timeout ? 504 : 503, {
      operation: 'auth.user', cause: error instanceof Error ? error.name : 'FetchError', retryable: true,
    });
  }
  if (!response.ok) throw new PushError('AUTHENTICATION_REQUIRED', 401, {
    operation: 'auth.user', retryable: false, cause: bounded(await response.text().catch(() => ''), 512),
  });
  const user = await response.json().catch(() => null);
  if (!user || typeof user.id !== 'string') throw new PushError('AUTHENTICATION_REQUIRED', 401);
  return { id: user.id };
}

async function db(path: string, options: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(15000),
      headers: {
        ...databaseHeaders(),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new PushError(timeout ? 'DATABASE_TIMEOUT' : 'DATABASE_UNAVAILABLE', timeout ? 504 : 503, {
      operation: 'supabase.rest', cause: error instanceof Error ? error.name : 'FetchError', retryable: true,
    });
  }
  if (!response.ok) throw new PushError(`DATABASE_HTTP_${response.status}`, response.status >= 500 ? 503 : 400, {
    operation: 'supabase.rest', retryable: response.status === 429 || response.status >= 500,
    cause: bounded(await response.text().catch(() => ''), 512),
  });
  if (response.status === 204) return null;
  return await response.json().catch(() => null);
}

function textField(value: unknown, name: string, max: number, required = false): string | null {
  if (typeof value !== 'string') {
    if (required) throw new PushError(`${name.toUpperCase()}_REQUIRED`, 400);
    return null;
  }
  const clean = value.trim();
  if (required && !clean) throw new PushError(`${name.toUpperCase()}_REQUIRED`, 400);
  if (clean.length > max) throw new PushError(`${name.toUpperCase()}_TOO_LONG`, 400);
  return clean || null;
}

function localUrl(value: unknown): string {
  const url = textField(value, 'url', 512) || '/';
  if (!url.startsWith('/') || url.startsWith('//')) throw new PushError('URL_MUST_BE_LOCAL', 400);
  return url;
}

function subscriptionInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PushError('SUBSCRIPTION_REQUIRED', 400);
  const item = value as Json;
  const endpoint = textField(item.endpoint, 'endpoint', 2048, true)!;
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new PushError('ENDPOINT_INVALID', 400); }
  if (parsed.protocol !== 'https:') throw new PushError('ENDPOINT_INVALID', 400);
  const p256dh = textField(item.keys && typeof item.keys === 'object' ? (item.keys as Json).p256dh : null, 'p256dh', 256, true)!;
  const auth = textField(item.keys && typeof item.keys === 'object' ? (item.keys as Json).auth : null, 'auth', 256, true)!;
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) throw new PushError('SUBSCRIPTION_KEYS_INVALID', 400);
  if (p256dh.length < 40 || auth.length < 8) throw new PushError('SUBSCRIPTION_KEYS_INVALID', 400);
  return {
    endpoint, p256dh, auth,
    user_agent: textField(item.userAgent, 'user_agent', 512),
    device_label: textField(item.deviceLabel, 'device_label', 80),
  };
}

function optionalEndpoint(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const endpoint = textField(value, 'endpoint', 2048, true)!;
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new PushError('ENDPOINT_INVALID', 400); }
  if (parsed.protocol !== 'https:') throw new PushError('ENDPOINT_INVALID', 400);
  return endpoint;
}

function safeEndpointLog(endpoint: string): string {
  try { return `${new URL(endpoint).origin}/…${endpoint.slice(-12)}`; } catch { return 'endpoint'; }
}

async function saveSubscription(user: User, value: unknown): Promise<Json> {
  const sub = subscriptionInput(value);
  await db('push_subscriptions?on_conflict=user_id%2Cendpoint', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ ...sub, user_id: user.id, enabled: true, failure_count: 0, updated_at: new Date().toISOString() }]),
  });
  console.info(JSON.stringify({ event: 'subscription_saved', user_id: user.id, endpoint: safeEndpointLog(sub.endpoint) }));
  return { enabled: true };
}

async function removeSubscription(user: User, value: unknown): Promise<Json> {
  const endpoint = textField(value, 'endpoint', 2048, true)!;
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new PushError('ENDPOINT_INVALID', 400); }
  if (parsed.protocol !== 'https:') throw new PushError('ENDPOINT_INVALID', 400);
  const query = new URLSearchParams({ user_id: `eq.${user.id}`, endpoint: `eq.${endpoint}` });
  await db(`push_subscriptions?${query}`, { method: 'DELETE' });
  console.info(JSON.stringify({ event: 'subscription_removed', user_id: user.id, endpoint: safeEndpointLog(endpoint) }));
  return { enabled: false };
}

function notificationInput(value: unknown): { title: string; body: string; url: string; icon: string; badge: string; tag: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PushError('NOTIFICATION_REQUIRED', 400);
  const item = value as Json;
  return {
    title: textField(item.title, 'title', 120, true)!,
    body: textField(item.body, 'body', 500, true)!,
    url: localUrl(item.url),
    icon: '/roggy-buy-list/icon.svg',
    badge: '/roggy-buy-list/icon.svg',
    tag: textField(item.tag, 'tag', 80) || 'roggy-lists',
  };
}

function isoField(value: unknown, name: string, required = true): string | null {
  const text = textField(value, name, 64, required);
  if (!text) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new PushError(`${name.toUpperCase()}_INVALID`, 400);
  return date.toISOString();
}

function cameraEventInput(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PushError('CAMERA_EVENT_REQUIRED', 400);
  const item = value as Json;
  const cameraId = textField(item.camera_id, 'camera_id', 64, true);
  if (cameraId !== 'front_door') throw new PushError('CAMERA_NOT_ALLOWED', 400);
  const eventKey = textField(item.event_key, 'event_key', 160, true)!;
  if (!/^front_door_[0-9_-]+\.jpg$/.test(eventKey)) throw new PushError('EVENT_KEY_INVALID', 400);
  const snapshotName = textField(item.snapshot_name, 'snapshot_name', 160, true)!;
  if (snapshotName !== eventKey) throw new PushError('SNAPSHOT_NAME_INVALID', 400);
  const analysis = item.analysis && typeof item.analysis === 'object' && !Array.isArray(item.analysis)
    ? { ...(item.analysis as Json) } : {};
  delete analysis.snapshot_path;
  if (JSON.stringify(analysis).length > 24000) throw new PushError('ANALYSIS_TOO_LARGE', 400);
  return {
    event_key: eventKey,
    camera_id: cameraId,
    camera_name: textField(item.camera_name, 'camera_name', 128, true)!,
    location: textField(item.location, 'location', 128, true)!,
    captured_at: isoField(item.captured_at, 'captured_at')!,
    analysis_completed_at: isoField(item.analysis_completed_at, 'analysis_completed_at', false),
    short_description: textField(item.short_description, 'short_description', 80, true)!,
    full_description: textField(item.full_description, 'full_description', 600, true)!,
    summary: textField(item.summary, 'summary', 1000, true)!,
    snapshot_name: snapshotName,
    analysis,
  };
}

async function saveCameraEvent(user: User, value: unknown): Promise<Json> {
  const event = cameraEventInput(value);
  await db('camera_events?on_conflict=user_id%2Cevent_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ ...event, user_id: user.id }]),
  });
  let push: Json;
  try {
    push = { attempted: true, ...(await sendPushNotification(user.id, notificationInput({
      title: 'Front Door Cam',
      body: event.short_description,
      url: `/roggy-buy-list/?page=front-door&event=${encodeURIComponent(String(event.event_key))}`,
      tag: `front-door-${event.event_key}`,
    }))) };
  } catch (error) {
    const code = error instanceof PushError ? error.code : 'PUSH_SEND_FAILED';
    push = { attempted: true, delivered: false, error: code };
    console.error(JSON.stringify({ event: 'camera_event_push_failed', user_id: user.id, error_code: code }));
  }
  console.info(JSON.stringify({ event: 'camera_event_persisted', user_id: user.id, event_key: event.event_key }));
  return { ok: true, event_key: event.event_key, push };
}

async function cleanupCameraEvents(user: User): Promise<Json> {
  const now = Date.now();
  const imageBefore = new Date(now - 14 * 86400000).toISOString();
  const trashBefore = new Date(now).toISOString();
  const oldImages = await db(`camera_events?user_id=eq.${encodeURIComponent(user.id)}&captured_at=lt.${encodeURIComponent(imageBefore)}`, {
    method: 'DELETE', headers: { Prefer: 'return=representation' },
  });
  const expiredTrash = await db(`camera_events?user_id=eq.${encodeURIComponent(user.id)}&deleted_at=not.is.null&trash_expires_at=lte.${encodeURIComponent(trashBefore)}`, {
    method: 'DELETE', headers: { Prefer: 'return=representation' },
  });
  return { ok: true, removed: (Array.isArray(oldImages) ? oldImages.length : 0) + (Array.isArray(expiredTrash) ? expiredTrash.length : 0) };
}

async function subscriptionRows(userId: string, endpoint: string | null, enabledOnly = false): Promise<PushSubscriptionRow[]> {
  const query = new URLSearchParams({ select: 'id,endpoint,p256dh,auth,enabled,failure_count,last_success_at,updated_at', user_id: `eq.${userId}` });
  if (endpoint) query.set('endpoint', `eq.${endpoint}`);
  if (enabledOnly) query.set('enabled', 'eq.true');
  const rows = await db(`push_subscriptions?${query}`);
  return Array.isArray(rows) ? rows as PushSubscriptionRow[] : [];
}

function storedSubscriptionIsValid(subscription: PushSubscriptionRow): boolean {
  try {
    const endpoint = new URL(subscription.endpoint);
    return endpoint.protocol === 'https:' && /^[A-Za-z0-9_-]{40,}$/.test(subscription.p256dh) && /^[A-Za-z0-9_-]{8,}$/.test(subscription.auth);
  } catch { return false; }
}

async function pushDiagnostics(userId: string, endpoint: string | null): Promise<Json> {
  let configuration: Json = { status: 'healthy' };
  try { pushConfiguration(); }
  catch (error) {
    const safe = error instanceof PushError ? error : new PushError('PUSH_CONFIGURATION_INVALID', 503, { operation: 'push.config', cause: error });
    configuration = { status: 'error', error_code: safe.code, message: safe.message };
  }
  const rows = await subscriptionRows(userId, endpoint, false);
  const match = endpoint ? rows[0] : null;
  const registration = match ? {
    status: match.enabled ? 'active' : 'disabled',
    structurally_valid: storedSubscriptionIsValid(match),
    failure_count: Number(match.failure_count) || 0,
    last_success_at: match.last_success_at || null,
    updated_at: match.updated_at || null,
  } : { status: 'missing', structurally_valid: false, failure_count: 0, last_success_at: null, updated_at: null };
  return {
    ok: true,
    push_backend: configuration,
    registration,
    stored_subscription_count: rows.length,
  };
}

async function sendPushNotification(userId: string, notification: ReturnType<typeof notificationInput>, endpoint: string | null = null): Promise<Json> {
  const subscriptions = await subscriptionRows(userId, endpoint, true);
  if (subscriptions.length === 0) {
    if (endpoint) {
      const matchingRows = await subscriptionRows(userId, endpoint, false);
      if (matchingRows.length > 0) throw new PushError('SUBSCRIPTION_DISABLED', 409, {
        message: 'This device subscription is disabled.', operation: 'push.lookup', retryable: false,
        details: { enabled: false, failure_count: Number(matchingRows[0].failure_count) || 0 },
      });
      throw new PushError('SUBSCRIPTION_NOT_REGISTERED', 409, {
        message: 'This browser subscription is not registered with Layne.', operation: 'push.lookup', retryable: false,
      });
    }
    throw new PushError('NO_ACTIVE_SUBSCRIPTION', 409, {
      message: 'No active push subscription is registered for this account.', operation: 'push.lookup', retryable: false,
    });
  }
  let sent = 0;
  let removed = 0;
  let failed = 0;
  let firstFailure: PushError | null = null;
  const payload = JSON.stringify({ title: notification.title, body: notification.body, icon: notification.icon, badge: notification.badge, tag: notification.tag, url: notification.url });
  pushConfiguration();
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 300 });
      sent++;
      try {
        await db(`push_subscriptions?id=eq.${encodeURIComponent(subscription.id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ last_success_at: new Date().toISOString(), failure_count: 0, enabled: true, updated_at: new Date().toISOString() }),
        });
      } catch (error) {
        console.error(JSON.stringify({ event: 'subscription_success_update_failed', user_id: userId, endpoint: safeEndpointLog(subscription.endpoint), error: error instanceof PushError ? error.code : 'DATABASE_ERROR' }));
      }
    } catch (error) {
      const status = providerStatusCode(error);
      if (status === 404 || status === 410) {
        removed++;
        try { await db(`push_subscriptions?id=eq.${encodeURIComponent(subscription.id)}`, { method: 'DELETE' }); }
        catch (cleanupError) { console.error(JSON.stringify({ event: 'expired_subscription_cleanup_failed', user_id: userId, endpoint: safeEndpointLog(subscription.endpoint), error: cleanupError instanceof PushError ? cleanupError.code : 'DATABASE_ERROR' })); }
      } else {
        failed++;
        const nextFailureCount = Math.max(0, Number(subscription.failure_count) || 0) + 1;
        try {
          await db(`push_subscriptions?id=eq.${encodeURIComponent(subscription.id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ failure_count: nextFailureCount, enabled: nextFailureCount < 5, updated_at: new Date().toISOString() }),
          });
        } catch (updateError) { console.error(JSON.stringify({ event: 'subscription_failure_update_failed', user_id: userId, endpoint: safeEndpointLog(subscription.endpoint), error: updateError instanceof PushError ? updateError.code : 'DATABASE_ERROR' })); }
      }
      const classified = providerError(error, subscription);if(!firstFailure)firstFailure=classified;
    }
  }
  console.info(JSON.stringify({ event: 'push_send_complete', user_id: userId, sent, failed, removed, endpoint: endpoint ? safeEndpointLog(endpoint) : null, provider_status: firstFailure?.details?.provider_status || null }));
  if (firstFailure && sent === 0) {
    firstFailure.details = { ...firstFailure.details, sent, failed, removed, subscriptions: subscriptions.length };
    throw firstFailure;
  }
  return { sent, failed, removed, subscriptions: subscriptions.length };
}

async function handle(req: Request): Promise<Response> {
  const origin = originFor(req);
  const user = await authenticatedUser(req);
  const body = await readBody(req);
  const action = textField(body.action, 'action', 40, true);
  if (action === 'subscribe') return json(await saveSubscription(user, body.subscription), 200, origin);
  if (action === 'unsubscribe') return json(await removeSubscription(user, body.endpoint), 200, origin);
  if (action === 'diagnostics') return json(await pushDiagnostics(user.id, optionalEndpoint(body.endpoint)), 200, origin);
  if (action === 'send_test') {
    const result = await sendPushNotification(user.id, notificationInput({
      title: 'Roggy Lists', body: 'Push notifications are working.', url: '/', tag: 'roggy-test',
    }), optionalEndpoint(body.endpoint));
    return json({ ok: true, ...result }, 200, origin);
  }
  if (action === 'camera_event') return json(await saveCameraEvent(user, body.event), 200, origin);
  if (action === 'cleanup_camera_events') return json(await cleanupCameraEvents(user), 200, origin);
  throw new PushError('ACTION_NOT_SUPPORTED', 400);
}

Deno.serve(async req => {
  const origin = req.headers.get('origin') || PROJECT_ORIGIN;
  // A 204 response cannot carry a body. Returning JSON here makes Deno reject
  // the Response before it reaches the browser, which breaks CORS preflight.
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'access-control-allow-origin': origin === PROJECT_ORIGIN ? origin : PROJECT_ORIGIN,
      'access-control-allow-headers': 'authorization, apikey, content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      vary: 'Origin',
    },
  });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405, PROJECT_ORIGIN);
  try { return await handle(req); }
  catch (error) {
    const safe = error instanceof PushError ? error : new PushError('UNEXPECTED_ERROR', 500, {
      operation: 'push.request', cause: error instanceof Error ? error.name : 'UnknownError',
    });
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: 'push_request_failed', ...safe.toJSON(requestId) }));
    return json({ ok: false, error: safe.code, error_detail: safe.toJSON(requestId), requestId }, safe.status, origin === PROJECT_ORIGIN ? origin : PROJECT_ORIGIN);
  }
});
