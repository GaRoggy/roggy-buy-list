# Garmin integration discovery and implementation status

Date: 2026-10-10

## Decision

Use Garmin's official Health/Activity API for future automatic collection, but keep it disabled until Garmin approves this application and supplies the account-specific contract. Garmin describes its developer program as a business program with approval, OAuth 2.0, and possible commercial or minimum-device conditions. This project does not assume a personal account qualifies. The supported working path for this milestone is an explicitly selected Garmin account export, normalized locally or by the owner-authenticated Supabase control function.

The unofficial Garmin Connect login-client path is not implemented. The `python-garminconnect` project uses private Connect login/session behavior and documents portal-specific workarounds. That approach is a poor fit for the no-authentication-bypass, no-anti-bot-bypass, and no-rate-limit-bypass requirements, and would be less reliable than an approved provider contract. No Garmin username, password, MFA code, or token was requested or stored.

## Existing system reused

- `C:\Codex\LocalAgent` already contains the local Layne agent, `PersonalDataService`, a `CHECK_WEARABLE_DATA` capability, `/health-data`, and a Garmin OAuth/DPAPI token-storage skeleton. Its Garmin provider remains unconfigured until an approved OAuth/API contract is supplied.
- `C:\Codex\roggy-buy-list` already owns `monitor_records` and `monitor_sources`, owner-scoped read RLS, an authenticated dashboard, and the monitor service-role persistence pattern. The current schema accepts `health_measurement` and other record kinds; no new Garmin table or migration is needed for this import foundation.
- The local `C:\Codex\smart_home` repository has no Garmin reference. No Garmin bridge was found in the local Smart Home integration. A third-party Home Assistant Garmin Connect login integration was not installed or used.
- Roggy Lists already had a disabled placeholder in its unfinished health page. The change adds the shelf under the existing Tracking drawer category and uses that page without redesigning other shelves.

## Implementation

- Added a shared CSV/FIT normalizer at `supabase/functions/_shared/garmin-normalize.js`. It preserves source timestamp/timezone, unit, format and aggregation; rejects unsupported or out-of-range measurements; distinguishes missing values from zero; derives sleep-stage duration only from recorded transitions; strips unexpected fields; and excludes GPS coordinates. FIT monitoring counters are left out until their per-activity-type accumulation can be reconciled without double-counting.
- Added `monitor/garmin-import.mjs`. It reads selected CSV/FIT files from an extracted export, bounds files and records, rejects symlinks, previews by default, and only writes after `--apply`. Re-exported days and activities use stable identifiers so overlapping archives can update existing rows. Raw files and names are not uploaded or stored.
- Added synthetic CSV/FIT importer tests with the official Garmin FIT SDK. Added exact dependency pin `@garmin/fitsdk@21.217.0` and lockfile entry.
- Added and deployed an owner-JWT-verified control Edge Function for dashboard CSV import, manual-sync enqueue, and confirmed owner-scoped deletion. It is active in production with Supabase JWT verification enabled. A CSV selected in the dashboard is sent to the owner's Supabase function for normalization; raw input is not persisted. It uses server-side Supabase secrets and the existing RLS/schema. Manual sync requires an enabled `approved-api` source with an explicit sync flag plus a server-side implementation gate, so an export source cannot accidentally run as an automatic collector.
- Added the Tracking → Garmin page, purple responsive styling, stored-record cards, 7/30/90-day trend charts, activity summaries, source/freshness status, CSV import, disabled-until-authorized sync, troubleshooting, and confirmed data deletion controls. The page queries only the authenticated owner's existing rows and does not display workout locations.
- Extended Layne's existing health snapshot to include stored activity summaries, latest record freshness, source provenance, and explicit recorded-value semantics. Deterministic baseline/trend calculations remain local Python and do not require an LLM. No proactive briefing or announcement was enabled.
- No database migration, Garmin authentication, live sync, or real Garmin data retrieval was performed. The Pages publication is from the repository's existing `main`-branch root source.

## Limits and required user actions

1. Request eligibility and approved Health/Activity API access through the [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/program-faq/). If approved, use the contract Garmin supplies to implement its exact endpoints, scopes, delivery, rate limits, and correction behavior. Do not substitute private Connect endpoints.
2. No authentic Garmin export was found in this repository's expected project/import locations. The next action for real data is to download the [official Garmin account export](https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8) and extract supported CSV/FIT files to the local, Git-ignored `monitor/garmin-import/` folder. Preview with `npm run garmin:import -- "C:\Codex\roggy-buy-list\monitor\garmin-import"`; it is read-only by default. Review the metric list and date coverage before choosing a persistence path. The dashboard accepts a health-report or activity CSV, while the local CLI can preview supported CSV/FIT files without uploading the raw export.
3. Automatic scheduling, historical API backfill, incremental reconciliation, API retries, gaming-mode deferral, and live token-expiration handling require the approved provider contract. No hourly job is currently enabled.

## Verification status

Verified for Phase 2 with synthetic fixtures:

- `npm test`: 150 passed, 0 failed.
- `npm run build`: passed; 21 allow-listed static files copied, with no server code or `.env` included.
- Garmin handler harness: 17 passed across JWT identity, origin/content/body limits, normalization, Chicago timezone conversion, zero-versus-missing, owner filtering, stable upserts, retry after partial batches, and confirmed owner-scoped deletion. This uses a disposable in-process REST/Auth fixture, not production writes.
- Playwright Edge fixture smoke test: passed Tracking → Garmin navigation, cards/charts/activity details, GPS hiding, sync gating, sign-out, 390px mobile layout, no page exceptions, and a Garmin-free Home page.
- `LocalAgent` `tests/test_personal_data.py`: 7 passed for Layne's stored health snapshot and deterministic response behavior. No real Garmin rows were available for a live natural-language query.
- Full suite: 150 passed, 0 failed. `npm run test:garmin`: 17 passed, 0 failed. The standalone Edge TypeScript entrypoint also passed Node's type-stripping syntax check.

The production `garmin-control` function is active at version 2 with `verify_jwt: true`; its deployment bundle includes the shared normalizer. The test harness verifies the deployed handler's code path against a disposable REST/Auth fixture. No Garmin records or source rows were present in the production count check. The real authenticated upload path and authentic Garmin measurements remain unverified until a real export is supplied. No synthetic health data was written to production.

The live Edge Function rejected a no-write request with a malformed bearer token (`401 UNAUTHORIZED_INVALID_JWT_FORMAT`); the production database remained at zero Garmin sources and records. GitHub Pages run 430 completed successfully from `main` at the repository root. The live [Roggy Lists site](https://garoggy.github.io/roggy-buy-list/) showed the Garmin shelf, disabled automatic sync, zero-data metric cards, and the no-records import prompt. The Garmin-free Home page was verified by the fixture browser test. The change set excludes unrelated existing dirty files.

Primary references: [Garmin Health API](https://developer.garmin.com/gc-developer-program/health-api/), [Garmin program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/), [Garmin export help](https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8), and [Garmin FIT SDK](https://github.com/garmin/fit-javascript-sdk).
