-- Unified activity-history fields on the existing monitor_events projection.
-- Provider records, camera snapshots, and raw logs remain separate stores.

alter table public.monitor_sources drop constraint if exists monitor_sources_kind_check;
alter table public.monitor_sources add constraint monitor_sources_kind_check
  check (kind in ('calendar','gmail','finance','garmin','brief','smart_home','google_tasks',
                  'google_people','google_drive','unified_events'));

alter table public.monitor_events add column if not exists category text not null default 'system';
alter table public.monitor_events add column if not exists severity text not null default 'info';
alter table public.monitor_events add column if not exists room_id text;
alter table public.monitor_events add column if not exists device_id text;
alter table public.monitor_events add column if not exists related_entity text;
alter table public.monitor_events add column if not exists dedupe_key text;
alter table public.monitor_events add column if not exists incident_id text;
alter table public.monitor_events add column if not exists started_at timestamptz;
alter table public.monitor_events add column if not exists resolved_at timestamptz;
alter table public.monitor_events add column if not exists duration_seconds numeric;

alter table public.monitor_events drop constraint if exists monitor_events_severity_check;
alter table public.monitor_events add constraint monitor_events_severity_check
  check (severity in ('info','notice','warning','error','critical'));
alter table public.monitor_events drop constraint if exists monitor_events_category_check;
alter table public.monitor_events add constraint monitor_events_category_check
  check (category ~ '^[a-z][a-z0-9_.-]{1,63}$');
alter table public.monitor_events drop constraint if exists monitor_events_duration_check;
alter table public.monitor_events add constraint monitor_events_duration_check
  check (duration_seconds is null or duration_seconds >= 0);

create index if not exists monitor_events_owner_category_time
  on public.monitor_events(user_id, category, occurred_at desc);
create index if not exists monitor_events_owner_type_time
  on public.monitor_events(user_id, event_type, occurred_at desc);
create index if not exists monitor_events_owner_device_time
  on public.monitor_events(user_id, device_id, occurred_at desc)
  where device_id is not null;
create index if not exists monitor_events_owner_room_time
  on public.monitor_events(user_id, room_id, occurred_at desc)
  where room_id is not null;
create index if not exists monitor_events_owner_dedupe
  on public.monitor_events(user_id, dedupe_key, occurred_at desc)
  where dedupe_key is not null;
create index if not exists monitor_events_incident
  on public.monitor_events(user_id, incident_id, occurred_at desc)
  where incident_id is not null;

-- The existing RLS policy remains owner-only authenticated reads; only the
-- monitor service role can write this canonical projection.

-- Website mutations use this same database as a bounded ingestion queue. It
-- is not a second history store: the monitor worker normalizes each envelope
-- into monitor_events and removes the queue row after a successful upsert.
create table if not exists public.monitor_event_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  event jsonb not null check (jsonb_typeof(event) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists monitor_event_outbox_owner_time
  on public.monitor_event_outbox(user_id, created_at asc);

alter table public.monitor_event_outbox enable row level security;
revoke all on public.monitor_event_outbox from anon, authenticated;
grant insert on public.monitor_event_outbox to authenticated;
grant all on public.monitor_event_outbox to service_role;
drop policy if exists monitor_event_outbox_owner_insert on public.monitor_event_outbox;
create policy monitor_event_outbox_owner_insert on public.monitor_event_outbox
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
