create table if not exists public.camera_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null check (event_key ~ '^front_door_[0-9_-]+\.jpg$'),
  camera_id text not null check (camera_id = 'front_door'),
  camera_name text not null check (char_length(camera_name) between 1 and 128),
  location text not null check (char_length(location) between 1 and 128),
  captured_at timestamptz not null,
  analysis_completed_at timestamptz,
  short_description text not null check (char_length(short_description) between 2 and 80),
  full_description text not null check (char_length(full_description) between 1 and 600),
  summary text not null check (char_length(summary) between 1 and 1000),
  snapshot_name text not null check (snapshot_name = event_key),
  analysis jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  trash_expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint camera_events_user_event_key unique (user_id, event_key)
);

create index if not exists camera_events_user_captured_idx
  on public.camera_events (user_id, captured_at desc);

create index if not exists camera_events_user_trash_idx
  on public.camera_events (user_id, trash_expires_at)
  where deleted_at is not null;

create or replace function public.set_camera_event_trash_expiry()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.trash_expires_at := case when new.deleted_at is null then null
    else least(new.deleted_at + interval '7 days', new.captured_at + interval '14 days')
  end;
  return new;
end;
$$;

drop trigger if exists camera_events_set_trash_expiry on public.camera_events;
create trigger camera_events_set_trash_expiry
  before insert or update of deleted_at, captured_at on public.camera_events
  for each row execute function public.set_camera_event_trash_expiry();

revoke all on function public.set_camera_event_trash_expiry() from public;

alter table public.camera_events enable row level security;
revoke all on public.camera_events from anon, authenticated;
grant select on public.camera_events to authenticated;
grant update (deleted_at) on public.camera_events to authenticated;
grant all on public.camera_events to service_role;

drop policy if exists camera_events_owner_read on public.camera_events;
create policy camera_events_owner_read
  on public.camera_events for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists camera_events_owner_trash on public.camera_events;
create policy camera_events_owner_trash
  on public.camera_events for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
