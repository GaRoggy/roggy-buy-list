-- The first cloud migration briefly exposed a security-definer hide helper.
-- The current UI has no reminder-delete affordance, so keep the column as
-- reserved presentation state and remove the unused API surface entirely.
drop function if exists public.hide_calendar_reminder(uuid);
