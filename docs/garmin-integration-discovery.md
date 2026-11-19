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

- Added a shared CSV/FIT normalizer at `supabase/functions/_shared/garmin-normalize.js`. It preserves source timestamp/timezone, unit, format and aggregation; rejects unsupported or out-of-range measurements; distinguishes missing values from zero; derives sleep-stage duration only from recorded transitions; strips unexpected fields; and excludes GPS coordinates. FIT monitoring counters are reduced to each activity type's last source counter for a local day before disjoint types are combined, avoiding repeated-sample double counting. Supported wellness FIT fields include steps, calories, distance, heart rate, resting heart rate, HRV, respiration, SpO₂, stress, body battery samples/charge/drain, and sleep score/stages when those message fields exist in the export. CSV intensity-minute fields remain distinct; ambiguous FIT intensity-counter semantics are not guessed.
- Added `monitor/garmin-import.mjs`. It reads selected CSV/FIT files from an extracted export, bounds files and records, rejects symlinks, previews by default, and only writes after `--apply`. Re-exported days and activities use stable identifiers so overlapping archives can update existing rows. Raw files and names are not uploaded or stored.
- Added synthetic CSV/FIT importer tests with the official Garmin FIT SDK. Added exact dependency pin `@garmin/fitsdk@21.217.0` and lockfile entry.
- Added and deployed an owner-JWT-verified control Edge Function for dashboard CSV import, manual-sync enqueue, and confirmed owner-scoped deletion. It is active in production with Supabase JWT verification enabled. A CSV selected in the dashboard is sent to the owner's Supabase function for normalization; raw input is not persisted. It uses server-side Supabase secrets and the existing RLS/schema. Manual sync requires an enabled `approved-api` source with an explicit sync flag plus a server-side implementation gate, so an export source cannot accidentally run as an automatic collector.
- Added the Tracking → Garmin page, purple responsive styling, stored-record cards for heart rate, resting heart rate, steps, sleep stages, stress, Body Battery, calories, intensity, HRV, and training metrics, plus 7/30/90-day trends and activity summaries. The page shows record timestamps and last successful import/sync, labels missing measurements as “No data,” scopes records to the authenticated owner's Garmin sources, and does not display workout locations. CSV import, disabled-until-authorized sync, troubleshooting, and confirmed data deletion controls are included.
- Extended Layne's existing health snapshot to include stored activity summaries, latest record freshness, source provenance, and explicit recorded-value semantics. Deterministic baseline/trend calculations remain local Python and do not require an LLM. No proactive briefing or announcement was enabled.
- No database migration, Garmin authentication, live sync, or real Garmin data retrieval was performed. The Pages publication is from the repository's existing `main`-branch root source.

## Limits and remaining Garmin authorization steps

Live API access is a separate final milestone. No Garmin authorization or real Garmin request has succeeded, and the API source and automatic synchronization remain disabled.

1. Confirm that the Roggy Lists use case is eligible and request access to the [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/program-faq/), identifying the Health API and Activity API needs. Garmin currently describes the program as enterprise/business use; its FAQ says it will confirm application status within two business days, and some commercial metrics may have added license or minimum-device requirements.
2. If approved, use the Garmin Developer Portal, integration call, and evaluation environment to obtain the project-specific OAuth registration and API contract. Confirm the exact client setup, redirect/callback requirements, scopes or consent, payloads, push/pull delivery, history/backfill support, rate limits, retries, deletions/corrections, and commercial restrictions. Garmin confirms OAuth 2.0 for the program, but this implementation must use the details Garmin supplies rather than assume a grant flow or private endpoint.
3. Configure the approved credentials and callback only in the authorized server-side secret store. Complete consent for the Garmin account, implement the documented Health and Activity delivery paths, and normalize timestamped responses into the existing owner-scoped records. Keep credentials and tokens out of the static website and source control.
4. In Garmin's evaluation environment, verify an authorized Health API request and an Activity API request end to end, including timestamps, source attribution, corrections, and owner isolation. Only after a real authorized request succeeds should the API source gate and any scheduled sync be enabled.
5. Until then, the owner can request the [official Garmin account export](https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8) and extract supported CSV/FIT files to the local, Git-ignored `monitor/garmin-import/` folder. Garmin also documents a one-day wellness FIT export with fields such as steps, sleep, stress, and HRV; the local parser supports the FIT message types listed above when present. Preview with `npm run garmin:import -- "C:\Codex\roggy-buy-list\monitor\garmin-import"`; it is read-only by default. Use `--timezone IANA_ZONE` (or `MONITOR_TIMEZONE`) for the Garmin account's source timezone, inspect preview coverage/metrics/warnings, and apply only after review. The dashboard accepts a health-report or activity CSV; the local CLI can preview supported CSV/FIT files without uploading raw archives.

Automatic scheduling, historical API backfill, incremental reconciliation, API retries, gaming-mode deferral, and live token-expiration handling depend on the approved provider contract. No hourly job is enabled.

## Verification status

Verified locally with synthetic fixtures:

- `npm test`: 150 passed, 0 failed.
- `npm run build`: passed; 21 allow-listed static files copied, with no server code or `.env` included.
- Garmin handler harness: 17 passed across JWT identity, origin/content/body limits, normalization, Chicago timezone conversion, zero-versus-missing, owner filtering, stable upserts, retry after partial batches, and confirmed owner-scoped deletion. This uses a disposable in-process REST/Auth fixture, not production writes.
- Playwright Edge fixture smoke test: passed Tracking → Garmin navigation, all 12 charts, CSV/API-source fixture records, Garmin-source filtering, available and missing metric states, visible sync time, activity detail/GPS hiding, disabled sync gate, sign-out, 390px mobile layout, no page exceptions, and a Garmin-free Home page.
- `LocalAgent` `tests/test_personal_data.py`: 7 passed for Layne's stored health snapshot and deterministic response behavior. No real Garmin rows were available for a live natural-language query.
- Current task's `npm run test:garmin`: 22 passed, including synthetic FIT wellness counters, stress and body-battery messages, date-only precision, and omission of fabricated workout start times. No personal records were imported.
- Full suite: 150 passed, 0 failed. `npm run test:garmin`: 17 passed, 0 failed. The standalone Edge TypeScript entrypoint also passed Node's type-stripping syntax check.

The production `garmin-control` function is active at version 2 with `verify_jwt: true`; its deployment bundle includes the shared normalizer. The test harness verifies the deployed handler's code path against a disposable REST/Auth fixture. No Garmin records or source rows were present in the production count check. The real authenticated upload path and authentic Garmin measurements remain unverified until a real export is supplied. No synthetic health data was written to production.

The live Edge Function rejected a no-write request with a malformed bearer token (`401 UNAUTHORIZED_INVALID_JWT_FORMAT`); the production database remained at zero Garmin sources and records. GitHub Pages run 430 completed successfully from `main` at the repository root. The live [Roggy Lists site](https://garoggy.github.io/roggy-buy-list/) showed the Garmin shelf, disabled automatic sync, zero-data metric cards, and the no-records import prompt. The Garmin-free Home page was verified by the fixture browser test. The change set excludes unrelated existing dirty files.

Primary references: [Garmin Health API](https://developer.garmin.com/gc-developer-program/health-api/), [Garmin program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/), [Garmin export help](https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8), and [Garmin FIT SDK](https://github.com/garmin/fit-javascript-sdk).
