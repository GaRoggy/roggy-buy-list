import webpush from 'npm:web-push@3.6.7';

type Json = Record<string, unknown>;
type User = { id: string };
type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
};

class PushError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 500) {
    super(code);
    this.code = code;
    this.status = status;
  }
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
  } catch { throw new PushError('AUTHENTICATION_UNAVAILABLE', 503); }
  if (!response.ok) throw new PushError('AUTHENTICATION_REQUIRED', 401);
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
  } catch { throw new PushError('DATABASE_UNAVAILABLE', 503); }
  if (!response.ok) throw new PushError(`DATABASE_HTTP_${response.status}`, response.status >= 500 ? 503 : 400);
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
  return {
    endpoint, p256dh, auth,
    user_agent: textField(item.userAgent, 'user_agent', 512),
    device_label: textField(item.deviceLabel, 'device_label', 80),
  };
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

async function sendPushNotification(userId: string, notification: ReturnType<typeof notificationInput>): Promise<Json> {
  const query = new URLSearchParams({ select: 'id,endpoint,p256dh,auth,failure_count', user_id: `eq.${userId}`, enabled: 'eq.true' });
  const rows = await db(`push_subscriptions?${query}`);
  const subscriptions = Array.isArray(rows) ? rows as PushSubscriptionRow[] : [];
  let sent = 0;
  let removed = 0;
  let failed = 0;
  const payload = JSON.stringify({ title: notification.title, body: notification.body, icon: notification.icon, badge: notification.badge, tag: notification.tag, url: notification.url });
  webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 300 });
      sent++;
      await db(`push_subscriptions?id=eq.${encodeURIComponent(subscription.id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ last_success_at: new Date().toISOString(), failure_count: 0, enabled: true, updated_at: new Date().toISOString() }),
      });
    } catch (error) {
      const status = Number((error as { statusCode?: number })?.statusCode || 0);
      if (status === 404 || status === 410) {
        removed++;
        await db(`push_subscriptions?id=eq.${encodeURIComponent(subscription.id)}`, { method: 'DELETE' });
      } else {
        failed++;
        const nextFailureCount = Math.max(0, Number(subscription.failure_count) || 0) + 1;
        await db(`push_subscriptions?id=eq.${encodeURIComponent(subscription.id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ failure_count: nextFailureCount, enabled: nextFailureCount < 5, updated_at: new Date().toISOString() }),
        });
      }
    }
  }
  console.info(JSON.stringify({ event: 'push_send_complete', user_id: userId, sent, failed, removed }));
  return { sent, failed, removed, subscriptions: subscriptions.length };
}

async function handle(req: Request): Promise<Response> {
  const origin = originFor(req);
  const user = await authenticatedUser(req);
  const body = await readBody(req);
  const action = textField(body.action, 'action', 40, true);
  if (action === 'subscribe') return json(await saveSubscription(user, body.subscription), 200, origin);
  if (action === 'unsubscribe') return json(await removeSubscription(user, body.endpoint), 200, origin);
  if (action === 'send_test') {
    const result = await sendPushNotification(user.id, notificationInput({
      title: 'Roggy Lists', body: 'Push notifications are working.', url: '/', tag: 'roggy-test',
    }));
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
    const safe = error instanceof PushError ? error : new PushError('UNEXPECTED_ERROR');
    console.error(JSON.stringify({ error_code: safe.code }));
    return json({ ok: false, error: safe.code }, safe.status, origin === PROJECT_ORIGIN ? origin : PROJECT_ORIGIN);
  }
});
