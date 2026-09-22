# Personal Monitoring Agent: inspected architecture and implementation plan

Inspected 2026-09-21: GaRoggy/roggy-buy-list main at 8cd4d928da10b6e587e44ae145afd60d4f84bc1d; Supabase dplvxsniyqkwlmdzqbyg (Postgres 17).

## Existing application

Six static PWA files; no server, package manifest, tests, migration history in the repository, or persistent collectors. app.js uses Supabase with GitHub OAuth/PKCE. Lists, reminders, digestibles and manually entered budget data live in Supabase. Brain dumps and projects use localStorage. The home email panel is hard-coded. Health is a placeholder.

Existing tables: list_items, reminders, budget_entries, digestibles, bad_drivers, bad_driver_baseline_counts. Budget rows have user_id and owner RLS. Reminders have a globally unique external_id and no owner. Their current policies allow anonymous read/write; RLS being enabled does not protect them. Other existing public policies also deserve a separate review. No imported private content may enter reminders until access is restricted.

## Design

Windows Node 24 worker -> read-only provider APIs -> normalized records -> atomic Supabase commit of records and sync cursor -> deterministic analysis -> owner-only dashboard records. No LLM is required for the initial implementation. Interpretation that cannot be established deterministically stays unknown. Future LLM work must use bounded schemas, content hashes, cached results and treat provider text as untrusted data; it must have no action tools.

Use a common record envelope (source instance, owner, kind, external ID, event time, first ingestion, last synchronization, status, typed JSON payload). It permits new collectors without table proliferation while retaining source-specific structures. Separate records hold account balance snapshots, transactions, health measurements and daily summaries; nothing should overwrite historical measurements with a current balance. Explicit context links require evidence and confidence, not a speculative shared date alone.

Source state and job queue are durable in Supabase. Unique active source jobs prevent overlap. Claims use SKIP LOCKED and expiring leases with fencing tokens; stale workers cannot commit. Records and cursors commit together. Failures retry with bounded exponential backoff and jitter, then remain visibly failed. Scheduling resumes after reboot and offline periods without inventing successful syncs. Database/API responses and personal payloads never enter operational logs.

## Ordered delivery

1. Infrastructure: additive owner-protected tables; atomic jobs, leases, retries, structured logs, configuration and tests.
2. Calendar: OAuth read-only, complete paginated per-calendar rolling-window snapshots, safe disappearance reconciliation, recurrence instances and all-day dates; stable reminder mapping after privacy migration. Chosen over sync tokens so the moving recurrence window is reconciled correctly.
3. Gmail: read-only OAuth, history cursors and recovery, deterministic multi-category classification and conservative extraction. Promotions stay off the dashboard.
4. Garmin: official Health/Activity access gate, timestamped metric model, null for unavailable metrics. No credential scraping or fabricated live data.
5. Finance: authorized Plaid Transactions sync (pending/posted changes and removals), balance snapshots, transfer exclusion and currency-separated analysis. No payment APIs.
6. Reasoning: structured brief, rules and health correlation primitives with minimum sample size and no causal claims.
7. UI: use existing Supabase session and styles; replace static mail panel, show source freshness and errors, keep private information out of anonymous sessions and caches.

Every phase requires focused tests and a commit. Live integration verification additionally requires the user's OAuth/provider credentials. Test fixtures are synthetic and never ingested into the live database.

## Access discovered and blockers

GitHub and Supabase connectors can inspect the actual project; Gmail and Calendar tools are present in this conversation. None supplies a reusable worker refresh token. No Google, Plaid, Garmin or Supabase worker secrets were found in this process environment. User-owned Google Cloud Desktop OAuth credentials and consent are required. Finance provider production access and institution linking are required. Garmin's official developer program is business-oriented and approval-gated; eligibility and approved API documentation must be established before a live adapter can be completed. Export import is a possible explicitly chosen fallback, not a replacement for continuous sync.

## Documentation verified

- https://developers.google.com/workspace/calendar/api/guides/sync
- https://developers.google.com/workspace/gmail/api/guides/sync
- https://developers.google.com/identity/protocols/oauth2/native-app
- https://plaid.com/docs/api/products/transactions/
- https://developer.garmin.com/gc-developer-program/program-faq/
- https://supabase.com/docs/guides/database/postgres/row-level-security

Deployment must preserve existing data. The reminder privacy migration derives the sole existing budget owner and aborts if ambiguous. It does not guess ownership in a multi-user database. A reviewed migration and real-user sign-in test precede calendar ingestion.
