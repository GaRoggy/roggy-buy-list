# Lighting and routines

Devices now presents room and subcategory groups with power switches and live brightness sliders. Room summaries and groups open a lighting dialog; its individual-light list opens bulb controls, with a group back button and explicit close buttons. Connection diagnostics sit below the controls.

The full-spectrum wheel uses hue and saturation. The circular white wheel follows each target's overlapping supported Kelvin range. Selecting a tab sends no command. Pointer moves send live updates before release. One browser queue coalesces every affected bulb into a batch and retains the latest absolute settings across color, white temperature, brightness, and power. Device snapshots refresh the displayed hue, saturation, temperature, and active color mode. Keyboard controls are supported.

Group delivery uses owner-authenticated `/smart-home/lights/actions` and `/smart-home/lights/status` routes. These have reserved bridge capacity, independent of ordinary snapshot requests. The original per-bulb fan-out exceeded the bridge's four-request limit: rejected requests were dropped, leaving only some lights updated. Batches avoid that fan-out, retry transient HTTP failures, and suppress redundant full-page refreshes during a gesture.

The local coordinator, `C:\Codex\smart_home\light_delivery.py`, sends matching Home Assistant targets in one light-service call with an entity-ID array. It reads each bulb back concurrently and retries only bulbs that have not confirmed the requested state, up to four attempts. The UI distinguishes acceptance from confirmation and names any unsynced lights. New revisions supersede obsolete retries; color and temperature are mutually exclusive, pending brightness is retained, and subsequent native Layne commands supersede older website work. Confirmed final changes enter the existing completion journal after the gesture settles. Light switches and sliders on the Home and Devices pages use the same delivery path.

Settings has one persistent color wheel that changes the application's shared palette variables continuously. Light and dark appearance remain available.

System → Routines provides the configured local automations plus the Home Assistant Wake Up and Good Night sequences. Cards expose Run now and Cancel. Each routine has Today, History, and About tabs. Individual run details include trigger classification, accepted commands, confirmed state changes, saved announcements, and the morning briefing's Spanish word and detailed weather.

The backend is the existing local smart-home service, not a browser-direct Home Assistant connection. Its additional modules are in `C:\Codex\smart_home`: `routine_history.py`, `routines_api.py`, and `routine_observer.py`. Owner-authenticated routes are proxied by the existing private bridge. The SQLite history lives at `C:\Codex\smart_home\data\routine-history.sqlite3`. The Home Assistant observer subscribes read-only to routine service and state events and correlates their contexts; unrelated speech is excluded.

Historical morning data is a snapshot of the briefing actually dispatched for that run. Existing success markers are imported as summaries only; missing historical speech and forecasts are never reconstructed as if they were recorded. New routine runs retain the full available details. Cancellation stops remaining steps and requests the relevant existing Home Assistant stop action; completed effects remain in history.

Validation for reliable delivery: 174 website tests; 203 smart-home tests plus eight subtests (one existing skip); six-light browser checks including an initial HTTP 429, scoped groups and individual controls, external state synchronization, and general app/completion-feed regressions. Delivery tests cover every mode, lagging/unreachable bulbs, idempotency, superseded commands, zero-brightness recovery, and authenticated HTTP routes. Live verification on November 19, 2026 confirmed all six living-room bulbs for RGB cyan at 53%, 5800 K at 74%, power off, and rapid color/temperature/brightness changes. All six were left on at 2103 K and 65%, with independent per-device confirmation. Group convergence took 1.26–1.79 seconds in these checks. No physical simultaneity is assumed: each bulb must report the requested state.

Pre-change snapshot retained: `2026-11-19_103624_before-light-wheels-routine-history-website`.

Delivery-fix snapshot retained: `2026-11-19_174626_before-reliable-group-light-delivery`.
