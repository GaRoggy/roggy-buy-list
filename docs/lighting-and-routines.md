# Lighting and routines

Devices now presents room and subcategory groups with power switches and live brightness sliders. Room summaries and groups open a lighting dialog; its individual-light list opens bulb controls, with a group back button and explicit close buttons. Connection diagnostics sit below the controls.

The full-spectrum wheel uses hue and saturation. The circular white wheel follows each target's overlapping supported Kelvin range. Selecting a tab sends no command. Pointer moves send commands immediately through one coalescing queue per bulb; all modes share that queue so an older unsent color cannot replace a newer temperature. Independent bulbs send concurrently. Device snapshots refresh the displayed hue, saturation, temperature, and active color mode. Keyboard controls are supported.

Settings has one persistent color wheel that changes the application's shared palette variables continuously. Light and dark appearance remain available.

System → Routines provides the configured local automations plus the Home Assistant Wake Up and Good Night sequences. Cards expose Run now and Cancel. Each routine has Today, History, and About tabs. Individual run details include trigger classification, accepted commands, confirmed state changes, saved announcements, and the morning briefing's Spanish word and detailed weather.

The backend is the existing local smart-home service, not a browser-direct Home Assistant connection. Its additional modules are in `C:\Codex\smart_home`: `routine_history.py`, `routines_api.py`, and `routine_observer.py`. Owner-authenticated routes are proxied by the existing private bridge. The SQLite history lives at `C:\Codex\smart_home\data\routine-history.sqlite3`. The Home Assistant observer subscribes read-only to routine service and state events and correlates their contexts; unrelated speech is excluded.

Historical morning data is a snapshot of the briefing actually dispatched for that run. Existing success markers are imported as summaries only; missing historical speech and forecasts are never reconstructed as if they were recorded. New routine runs retain the full available details. Cancellation stops remaining steps and requests the relevant existing Home Assistant stop action; completed effects remain in history.

Validation: 163 website tests; 180 smart-home tests plus eight subtests (one existing skip); browser interaction and existing application regression checks; and live RGB/temperature readback on one active mood bulb, restored to its original 2000 K and 33% brightness. Cloud Garmin control and camera push fixes were published as function versions 3 and 6 respectively, preserving their previous JWT settings.

Pre-change snapshot retained: `2026-11-19_103624_before-light-wheels-routine-history-website`.
