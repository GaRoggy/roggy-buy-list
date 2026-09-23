# Roggy Lists personal monitor

## Private local AI

The existing PWA now includes **More → Local AI**. It talks to Ollama through a Windows-only bridge that validates the signed-in owner with Supabase, calls Ollama only on `127.0.0.1:11434`, and exposes the bridge privately through Tailscale Serve. It does not add a public endpoint, store conversation history in Supabase, or place privileged keys in browser code. Complete the PC and iPhone setup in [docs/ollama-setup.md](docs/ollama-setup.md).

The existing static PWA remains the frontend. A separate Node 24 Windows process reads authorized providers and writes owner-protected Supabase records. Architecture and the inspected baseline are in [docs/monitor-architecture.md](docs/monitor-architecture.md).

## Delivery status

Implemented and tested locally: durable queue, fenced leases, retries, source status, Calendar snapshots with reminder projection, Gmail history sync, Plaid Transactions sync, deterministic analysis, structured daily brief and dashboard panels. No LLM calls and no external send/edit/payment operations exist.

**Live monitoring is not yet configured.** Google OAuth, a Supabase server secret, and finance provider authorization are required. Garmin live collection is blocked on official API eligibility/access; enabling it does not simulate success. No fake data is inserted into Supabase.

The foundation and privacy migrations were applied to the existing project on 2026-09-21 (UTC versions 20260922005732 and 20260922005746), followed by legacy-cancellation reconciliation on 2026-09-22 (20260922121750). Live verification found all 19 existing reminders preserved with owners assigned, zero imported monitoring records, RLS enabled, anonymous reads denied, and browser execution of worker functions denied. Do not apply those migrations again to this project. The frontend changes remain on the development branch until reviewed/merged.

The live security advisor reported no monitoring-table findings. It did report the existing **Leaked Password Protection Disabled** Auth setting; [Supabase's remediation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) explains enabling it. The app currently uses GitHub OAuth; that project-wide setting was not changed.

## Database and security

The migrations are additive except for deliberately restricting the existing Reminders table to its owner. They preserve existing rows, IDs and completion state. The reminder migration derives the sole distinct owner from existing budget_entries and aborts if ownership is ambiguous. Review before applying to another project. Imported reminders cannot be edited through the browser. Calendar changes update them atomically with the source record and sync cursor.

Use the Supabase migration workflow against the inspected project. This repo did not contain the project's earlier migration history; **do not run a production db reset** or assume these migrations recreate the whole app. Apply pending migrations in timestamp order, and verify existing reminders after signing in. Authenticated users can read only their monitor rows. Anonymous clients have no access to monitoring data or reminders. Existing unrelated public list/digestible/driver policies were not changed.

Server key stays on this PC only; it bypasses RLS and must never enter frontend JavaScript. The existing browser publishable key is public by design. Credentials go in ignored `.env` or Windows DPAPI storage; raw provider bodies, email contents and tokens are excluded from logs. Normalized email snippets, transactions and health data in Supabase remain sensitive. Back up the database and use a retention policy appropriate for your data. Raw mail and attachments are not retained.

## Configure the Windows worker

1. Install Node.js 24 LTS and Git for Windows, or use verified existing executables. Run commands from the repository root.
2. Copy `.env.example` to `.env`. Fill in `SUPABASE_SECRET_KEY` from your project's server API settings and `MONITOR_USER_ID` from **Authentication → Users**, using the GitHub-authenticated user that owns your budget. Do not paste secrets into chat.
3. Keep `SUPABASE_URL=https://dplvxsniyqkwlmdzqbyg.supabase.co`. Set `MONITOR_TIMEZONE` to your IANA time zone. Default is `America/Chicago`.
4. Apply and verify the reviewed migrations before enabling sources.

There are no production npm dependencies. You can run `node` commands directly; no package installation is needed.

## Google authorization and sync

1. In [Google Cloud Console](https://console.cloud.google.com/), select your own project. Enable **Gmail API** and **Google Calendar API**.
2. Configure the OAuth consent screen for personal use and add your Google account as a test user if the application is in Testing. Create an OAuth client of type **Desktop app**.
3. Put the client ID and client secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. Run `node --env-file=.env monitor/google-auth.mjs`. Open the printed URL **on this PC** and approve only Gmail read-only and Calendar read-only. The callback listens on localhost for five minutes with PKCE and state validation. The refresh token is encrypted with Windows DPAPI in `.secrets/google.tokens.json`; only the same Windows account can decrypt it. Alternatively provide `GOOGLE_REFRESH_TOKEN` through your environment.
5. Run `node --env-file=.env monitor/setup.mjs list-calendars`. Put chosen canonical IDs into `GOOGLE_CALENDAR_IDS` as a JSON array in `.env`, for example `["your-calendar-id"]`. Do not use the alias `primary`.
6. Run `node --env-file=.env monitor/setup.mjs google`, then `node --env-file=.env monitor/setup.mjs brief`.
7. Run `node --env-file=.env monitor/worker.mjs --once` twice. Verify source success timestamps, unchanged record/reminder counts on the second run, and updates/cancellations after changing a test event yourself in Google Calendar.

Google OAuth apps in external Testing may receive refresh tokens that expire after seven days for these scopes. Follow Google's production/verification requirements for your use case; reauthorize when required. A revoked token stops that source and displays an error; it never switches to password scraping.

Run authorization from your normal signed-in Windows PowerShell session. The development tool session's DPAPI roundtrip was blocked because its impersonated user profile was not loaded. The code fails closed with `SECRET_STORE_ERROR`; it does not fall back to plaintext or disable Windows protection. DPAPI authorization and scheduled-task execution still require validation in your normal Windows account.

Calendar uses complete paginated snapshots every five minutes over the previous 30 days and next 366 days. Recurring instances, cancellations and reschedules are reconciled only after a full successful fetch. Dates outside the window become inactive locally, not externally deleted. All-day dates preserve their exclusive end and time zone. It intentionally uses bounded snapshots instead of sync tokens because a moving recurrence window requires reconciliation. Every imported active event projects into Reminders. Legacy reminders with an exact event ID are adopted; other historical imported rows need explicit mapping rather than guessing.

Gmail bootstraps the last 90 days, then uses history IDs for additions, deletions and label changes. An expired history ID triggers reconciliation including previously imported IDs. Classification is rule-based. Promotions, spam, sent mail and routine newsletters stay off the main dashboard. Ambiguous dates, currencies and extracted actions remain null; this version does not promise complete semantic extraction. Emails never trigger replies or sends.

## Finance authorization and behavior

Use your own approved [Plaid production application and Link flow](https://plaid.com/docs/link/) with the Transactions product. Complete institution consent through Plaid Link; exchange the resulting public token server-side via Plaid's supported `/item/public_token/exchange` flow. Store the resulting access token and Item ID in `.env` (`PLAID_ACCESS_TOKEN`, `PLAID_ITEM_ID`) together with `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=production`. The monitor does not collect bank credentials, and this repository does not yet supply a Plaid Link onboarding UI.

Run `node --env-file=.env monitor/setup.mjs finance`. Only one configured Plaid Item is supported by the current local credential configuration. More items require separate credential references rather than mixing access tokens.

Transactions sync hourly with pagination, cursor mutation restarts, removals and pending-to-posted replacement. Current account data and hourly balance snapshots use provider-cached balances; retrieved time is not falsely labeled the bank's balance update time. Currency totals remain separate. Transfers and credit-card payments identified by provider categories are excluded; unknown transfers require review. Rules identify possible duplicate charges, large purchases and candidate monthly recurring charges/price changes. Predicted dates are estimates, not verified bills. Statistical spending anomalies, confirmed subscription detection and savings-trend analysis need further work and live validation. No payments, transfers, purchases or account-management endpoint is available to the worker.

## Garmin access

The official [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/program-faq/) is approval-gated and intended for business use. First establish eligibility and obtain approved Health/Activity API access and documentation. This personal app may not qualify. Once that is known, implement and validate a provider mapping and OAuth/delivery verification against the approved contract. An explicitly selected official export import can be added separately, but would not provide continuous monitoring.

`node --env-file=.env monitor/setup.mjs garmin` registers a **disabled** source. Live collector status is `GARMIN_APPROVED_API_ACCESS_REQUIRED`. The internal timestamped metric schema, daily grouping and correlation functions are implemented and tested. No Garmin credentials or unofficial login client are used. Unsupported metrics are absent, never zeros. Correlations require at least 30 unique paired days and nonzero variation; they are descriptive, include sample size, and make no causation/significance claim. Activity files, sleep stages and approved training/recovery mappings remain future work.

## Scheduling, start/stop and Windows recovery

Foreground: `node --env-file=.env monitor/worker.mjs`. One pass: append `--once`. Stop foreground with Ctrl+C. Each source schedules according to `interval_seconds`; the worker polls every 15 seconds. Briefs update every 15 minutes with a stable local-date key, so a morning brief is available without an AI call. Stable alert keys update existing dashboard items; this version sends no push/email notifications.

After OAuth and one-pass verification, run `monitor/windows/install.ps1 -NodePath 'C:\absolute\path\to\node.exe'` from PowerShell with rights to register a startup task. It prompts locally for the **same Windows account** used for Google authorization. Windows Task Scheduler stores the task credential; the scripts do not save the password. Password logon is required for network/DPAPI access before desktop sign-in. Do not use S4U or another account for this task.

The task runs at boot and has a one-minute watchdog trigger, ignores overlapping launches, and has restart-on-failure settings. All subprocesses are hidden. It does not change execution policy, Defender, firewall or sleep settings. A sleeping or powered-off PC cannot collect; after wake/reboot the queue resumes. Ensure the PC's normal power settings meet your intended availability. If Windows blocks script execution, follow your normal code-signing policy rather than bypassing security controls.

- Stop: `Stop-ScheduledTask -TaskName 'Roggy Personal Monitor'` then `Disable-ScheduledTask -TaskName 'Roggy Personal Monitor'` to prevent watchdog restart.
- Start again: `Enable-ScheduledTask -TaskName 'Roggy Personal Monitor'`; `Start-ScheduledTask -TaskName 'Roggy Personal Monitor'`.
- Uninstall: `Unregister-ScheduledTask -TaskName 'Roggy Personal Monitor'` (confirm locally). It does not delete historical data or credentials.

## Logs, recovery and tests

JSON lines appear in the console and `logs/monitor-YYYY-MM-DD.jsonl`. Delete old log files according to your desired retention; automated retention is not implemented. `monitor_sources` records attempted/successful sync times, counts and safe error codes. `monitor_jobs`/`monitor_runs` preserve execution history and retries. Job results contain counts, not private payloads. Inspect the Task Scheduler Last Run Result if no source attempts appear.

Transient network/API errors retry up to five attempts with exponential backoff, jitter and Retry-After where available. Exhausted jobs are retained; the source can be scheduled again after an hour. Authentication/config errors disable that source until corrected and re-enabled with setup. A process crash leaves a lease that expires after two minutes; the new worker resumes it. A stale worker cannot commit records or advance cursors. Database loss pauses progress and preserves upstream cursors. No source failure crashes another source's collector.

Tests: `node --test monitor/test/*.test.mjs ai/test/*.test.mjs` (or `npm test`). The AI suite uses synthetic Supabase/Ollama responses and tests owner authorization, request limits, private model discovery, streaming, cancellation, timeouts, redacted logs and offline errors. Database integration tests run on disposable PGlite 0.5.8: `node monitor/test/database.mjs C:\path\to\pglite\dist\index.js`. The suite creates mock auth roles and the existing table shapes, then applies real migrations and tests SQL invariants. Synthetic fixture data is confined to the disposable test database. This is not a substitute for live OAuth, API permission, reboot and authenticated browser verification.

Browser smoke test (Playwright with installed Microsoft Edge): `node monitor/test/browser.mjs C:\path\to\playwright\index.mjs`. Optional third argument saves a screenshot. This test uses an isolated browser and synthetic API fixtures, not your live account.

## Add another source

Add a collector in `monitor/` returning `{records,cursor}`. Each record needs a stable kind/external_id, occurrence timestamp, processing status and normalized payload. Reuse existing source/owner provenance. Add the source kind constraint in a new CLI-generated migration, register the dispatcher, document read-only scopes and credentials, and add pagination, deletion, duplicate/retry, authorization and failure tests. Keep cursor advancement inside `monitor_commit`. Add domain-specific rules to the brief only with explicit evidence and stable keys. Never place credentials in `monitor_sources.config` or payloads.

Reviewable development branch commits document each phase. Do not merge the frontend until migrations and sign-in behavior are verified together.
