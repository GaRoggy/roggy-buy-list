# Layne completion history

The bottom of AI now lists completed commands, routines, verified processes and computer tasks, and scheduled monitor jobs. Each entry has an America/Chicago timestamp, a Test / User initiated / Automated label, a two-sentence outcome summary, and selectable expanded details with a close button. New completions arrive through an owner-authenticated live stream and are merged by stable ID in reverse completion order.

Recording occurs at final result boundaries. Failed, still-running, confirmation-gated and cancelled tasks are excluded. Routine steps remain in their existing history; a separate completion entry is published only after successful completion. Existing recorded successful routines are imported with their original timestamps, without inventing missing historical speech or results.

The private local journal is `C:\Codex\LocalAgent\data\layne-completions.sqlite3`, maintained by `C:\Codex\layne_event_history\completions.py`. LocalAgent tool/process/computer hooks and the smart-home action/routine hooks write directly. Monitor jobs hand off atomic records through the ignored `logs/completion-outbox` directory. Journal failures are isolated from task execution.

Entries expire exactly nine days after completion. API reads exclude expired entries and delete their rows; a background retention worker also deletes expired rows every 30 seconds without requiring an open browser. The browser removes expired entries locally. This retention is specific to the AI completion feed and does not erase the separately retained routine history.

Read routes use the existing private bridge: `/smart-home/completions`, `/smart-home/completions/<id>`, and `/smart-home/completions/stream?after=<sequence>`. The bridge and local service require the signed-in owner; there is no public browser write route. Details are fetched only when selected, and credentials are filtered before storage. Test fixtures use isolated journals and do not seed live activity.

Validation includes the website/bridge suite; tool/process/orchestration/computer regressions; smart-home regressions; expiry, physical background deletion, trigger classification, replay deduplication, pagination and owner HTTP/SSE tests; browser checks for live insertion, mobile layout, escaped content, detail navigation and sign-out clearing; and a real read-only GET_CURRENT_TIME process labelled Test, whose verified completion was immediately recorded.

Pre-change backup retained: `2026-11-19_111418_before-layne-completion-feed-nine-day-retention`.
