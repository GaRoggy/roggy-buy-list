# Roggy Lists Web Push

This document covers the generic Web Push infrastructure only. It does not connect notifications to Layne, cameras, microphones, Home Assistant, Alexa, reminders, lists, or any other event source.

## Current architecture

- `push-notifications.js` provides the Settings controls and requests browser permission only after an explicit **Enable Notifications** click.
- `sw.js` handles generic `push` and `notificationclick` events. Notification URLs and icons are restricted to the Roggy Lists origin and app path.
- `supabase/migrations/20260930235000_push_subscriptions.sql` creates `public.push_subscriptions` with owner-scoped RLS.
- `supabase/functions/push-notifications/index.ts` authenticates the signed-in user, stores or removes subscriptions, sends a generic test notification, and removes expired endpoints.
- `scripts/generate-vapid.mjs` creates the VAPID keypair once without printing the private key.

The deployed function is `push-notifications` in Supabase project `dplvxsniyqkwlmdzqbyg`. It intentionally uses custom bearer-token validation and therefore has `verify_jwt=false`; the function validates the session through Supabase Auth before any subscription or send operation.

## Database and security

`push_subscriptions` stores one row per signed-in user and endpoint:

- `user_id`, `endpoint`, `p256dh`, and `auth` are required.
- `user_agent` and `device_label` are optional diagnostics.
- `enabled`, `failure_count`, `last_success_at`, `created_at`, and `updated_at` support delivery health and cleanup.
- `(user_id, endpoint)` is unique.
- Anonymous access is revoked. Authenticated users can only select, insert, update, or delete their own rows through RLS.

The browser contains only the VAPID public key and the existing Supabase publishable key. The VAPID private key and all server-side send authority remain outside browser code. Supabase's guidance likewise treats exposed tables as RLS-protected data and server secrets as server-side configuration: [RLS security guidance](https://supabase.com/docs/guides/database/secure-data) and [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets).

## Configure the function secrets

The keypair is stored locally at:

`C:\Codex\roggy-buy-list\.secrets\push-vapid.json`

That directory is ignored by Git. The public key is already embedded in `push-notifications.js`; do not copy the private key into that file, GitHub Pages, browser storage, or chat.

In the Supabase Dashboard for project `dplvxsniyqkwlmdzqbyg`, add these Edge Function secrets:

| Secret | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | The `publicKey` value from the local keypair file |
| `VAPID_PRIVATE_KEY` | The `privateKey` value from the local keypair file |
| `VAPID_SUBJECT` | A real contact URI, normally a `mailto:` address you control or an HTTPS contact URL |

`SUPABASE_URL` and the project key variables are supplied by Supabase. The function supports the current grouped key variables and the legacy service-role/anonymous variable names. Never put a service or secret key into the PWA.

## User flow

1. Sign in to Roggy Lists.
2. On a supported HTTPS browser, open **More → Settings**.
3. Press **Enable Notifications**. Permission is not requested during page load.
4. After the browser grants permission, the subscription is saved for that user and device.
5. **Send Test Notification** sends only the generic “Push notifications are working.” payload.
6. **Disable Notifications** removes the endpoint from the backend and unsubscribes this browser where supported.

The backend supports multiple endpoints per user. A successful send resets delivery failures. HTTP 404/410 endpoints are deleted; other repeated failures are disabled after five failures.

## iPhone/iPad limitation

On iOS/iPadOS, Web Push requires the site to be added to the Home Screen and opened as a standalone web app. The UI reports this requirement and does not claim support in an ordinary browser tab. Physical iPhone verification is not included in this setup.

After the secrets are configured, verify manually on the iPhone:

1. Open the deployed Roggy Lists site in Safari and add it to the Home Screen.
2. Launch the Home Screen app, sign in, and press **Enable Notifications**.
3. Allow notifications, then press **Send Test Notification**.
4. Lock or background the app, confirm the generic notification arrives, and tap it to confirm that it focuses or opens Roggy Lists.

## Future integrations

Future server-side event code should call the existing `sendPushNotification` flow with a bounded title/body, a local app URL, and an optional tag. No event integrations were added here. Do not expose a public unauthenticated send endpoint and do not send arbitrary external URLs in notification payloads.

## Verification performed

- Generated a VAPID keypair locally without printing the private key.
- Built and deployed the `push-notifications` Edge Function.
- Applied and read back the subscription table, RLS, and four owner policies.
- Added the service-worker handlers and registered the worker from the PWA.
- Browser/iPhone delivery was not claimed as verified; it requires the secrets above and a real device/browser permission flow.
