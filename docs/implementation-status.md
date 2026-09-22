# Implementation and activation status

## Completed development work

1. **Infrastructure:** owner-protected Supabase tables, durable job/run history, atomic record/cursor commits, fenced leases, bounded retries, safe logs and source status. Migrations applied to the existing project.
2. **Calendar:** read-only OAuth, paginated rolling snapshots, recurring instances, all-day/DST preservation, stable reminder projection and cancellation reconciliation. Existing 19 reminders preserved and owner-protected.
3. **Gmail:** history sync and recovery, message deduplication/deletion/label handling, conservative classification and extraction, promotional suppression. No send/reply endpoints.
4. **Garmin foundation:** validated timestamped measurement schema, daily grouping and descriptive correlations. **Live adapter not implemented** because approved API access/documentation is unavailable.
5. **Finance:** production Plaid read-only transaction sync, pending replacement/removals, hourly balance history, transfer/card-payment exclusion, exact decimal totals, candidate duplicate/large/recurring/price-change rules.
6. **Brief and cross-source foundation:** structured daily brief, calendar conflicts/preparation/soon/busy-day calculations, source freshness, stable explained dashboard alerts and exact-reference candidate context links. No LLM calls or causal claims.
7. **Dashboard/Windows:** live-data email panel, monitoring status/brief panels, sign-out clearing and static-only caching; documented startup/watchdog scripts and source setup commands. Frontend is a development-branch change, not deployed.

## Validation performed

- 24 passing Node tests covering collector/rule behavior and failure handling.
- Disposable PostgreSQL/PGlite tests applying the real migrations: queue/record/reminder deduplication, transaction rollback, lease recovery/fencing, owner isolation, anonymous denial, DST, completion preservation and cancellations including legacy reminders.
- Headless Edge/Playwright fixture checks: rendering, HTML escaping, empty-reminder request loop prevention, sign-out state clearing, no page exceptions.
- PowerShell installer syntax check and JavaScript syntax checks.
- Initial live database checks: all 19 existing reminders preserved and owned, zero imported monitor records, anonymous SELECT denied, worker RPC execution denied to browser roles. A later check after unrelated ongoing app work found 28 reminders, all owned, and still zero imported monitor records.
- Live Supabase security advisor: existing leaked-password-protection Auth warning only; remediation linked in README.

## Not yet activated or verified

- No Google OAuth consent or real Gmail/Calendar synchronization has run from this worker.
- No Supabase worker secret is configured; no collector/source registration or service startup has run.
- No finance account is linked. Plaid production access and a supported Link consent flow are required. A Link onboarding UI is not included.
- Garmin developer eligibility/API approval is unresolved. No unofficial login or fabricated data fallback exists.
- The Windows tool session lacks a loaded per-user DPAPI profile. Normal-user OAuth encryption, unattended Task Scheduler credentials, reboot and crash recovery require validation on the real Windows session.
- Frontend remains unmerged; live signed-in browser validation is still required with the user's session.

## Further capability work

Semantic email extraction remains conservative (ambiguous dates/currencies/actions stay unknown). Garmin activities, sleep stages and provider mappings need approved schemas. Statistical unusual-spending detection, confirmed bills/subscriptions, savings trends and richer cross-source contexts remain future work. Current finance heuristics report candidates, not facts. Health correlations are descriptive only and do not establish statistical significance. Automated retention and push notifications are not implemented. Additional scheduled job types require new handlers.

See README for exact authentication, source setup, start/stop, recovery and extension instructions. These limits mean the complete always-on monitoring goal is **not yet achieved**.

The final branch was reconciled with main at 7516751422636b772e06d87f4f0bde6c391cf9ca, preserving the newer owner-only privacy gate, desktop styles and light/dark appearance controls. The fixture browser check passed again against that combined version.
