-- Cloud Google Calendar synchronization.
-- The existing monitor_records -> reminders trigger remains the single
-- projection path. These fields add provider provenance and cloud health
-- without creating a competing reminder system.

alter table public.reminders add column if not exists location text;
alter table public.reminders add column if not exists description text;
alter table public.reminders add column if not exists recurrence jsonb;
alter table public.reminders add column if not exists external_calendar_id text;
alter table public.reminders add column if not exists external_event_id text;
alter table public.reminders add column if not exists external_updated_at timestamptz;
alter table public.reminders add column if not exists external_original_start_at timestamptz;
alter table public.reminders add column if not exists sync_status text not null default 'active'
  check (sync_status in ('active', 'cancelled'));
alter table public.reminders add column if not exists hidden_locally boolean not null default false;

create index if not exists reminders_google_source_time
  on public.reminders(user_id, start_at)
  where source = 'google_calendar' and cancelled_at is null and hidden_locally = false;
create unique index if not exists reminders_google_event_unique
  on public.reminders(user_id, external_calendar_id, external_event_id)
  where source = 'google_calendar' and external_calendar_id is not null and external_event_id is not null;

alter table public.monitor_sources add column if not exists cloud_lease_until timestamptz;
alter table public.monitor_sources add column if not exists last_result jsonb not null default '{}';
create index if not exists monitor_sources_cloud_lease
  on public.monitor_sources(kind, enabled, cloud_lease_until)
  where kind = 'calendar';

-- Keep calendar metadata on the existing reminder row. A hidden row is never
-- unhidden by an upsert; the owner can choose to show it again explicitly.
create or replace function public.monitor_calendar_reminder() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
  p jsonb;
  legacy uuid;
  start_time timestamptz;
  end_time timestamptz;
  updated_time timestamptz;
  original_time timestamptz;
begin
  if new.kind <> 'calendar_event' then return new; end if;
  p = coalesce(new.payload, '{}'::jsonb);
  updated_time = nullif(p->>'updated', '')::timestamptz;
  original_time = case
    when jsonb_typeof(p->'original_start') = 'object' and p->'original_start' ? 'dateTime'
      then (p->'original_start'->>'dateTime')::timestamptz
    when jsonb_typeof(p->'original_start') = 'object' and p->'original_start' ? 'date'
      then ((p->'original_start'->>'date')::date::timestamp at time zone coalesce(p->>'time_zone','America/Chicago'))
    else null
  end;

  -- Adopt an exact legacy event ID belonging to this owner, preserving UUID.
  select id into legacy from public.reminders
   where user_id = new.user_id and source = 'google_calendar'
     and external_id = new.external_id and monitor_record_id is null;
  if legacy is not null then
    update public.reminders
       set monitor_record_id = new.id,
           external_id = 'monitor:' || new.source_id || ':' || new.external_id
     where id = legacy;
  end if;

  if new.status = 'deleted' then
    update public.reminders
       set cancelled_at = coalesce(cancelled_at, now()),
           sync_status = 'cancelled',
           external_updated_at = coalesce(updated_time, external_updated_at)
     where monitor_record_id = new.id;
    return new;
  end if;

  if coalesce((p->>'all_day')::boolean, false) then
    start_time = (p->>'start')::date::timestamp at time zone coalesce(p->>'time_zone','America/Chicago');
    end_time = (p->>'end')::date::timestamp at time zone coalesce(p->>'time_zone','America/Chicago');
  else
    start_time = (p->>'start')::timestamptz;
    end_time = (p->>'end')::timestamptz;
  end if;

  insert into public.reminders(
    user_id, monitor_record_id, title, start_at, end_at, all_day, start_date, end_date,
    source, external_id, location, description, recurrence, external_calendar_id,
    external_event_id, external_updated_at, external_original_start_at, sync_status
  ) values (
    new.user_id, new.id, coalesce(p->>'title','(Untitled event)'), start_time, end_time,
    coalesce((p->>'all_day')::boolean, false),
    case when coalesce((p->>'all_day')::boolean, false) then (p->>'start')::date end,
    case when coalesce((p->>'all_day')::boolean, false) then (p->>'end')::date end,
    'google_calendar', 'monitor:' || new.source_id || ':' || new.external_id,
    nullif(p->>'location',''), nullif(p->>'description',''), p->'recurrence',
    nullif(p->>'calendar_id',''), new.external_id, updated_time, original_time, 'active'
  )
  on conflict(monitor_record_id) do update set
    title = excluded.title,
    start_at = excluded.start_at,
    end_at = excluded.end_at,
    all_day = excluded.all_day,
    start_date = excluded.start_date,
    end_date = excluded.end_date,
    location = excluded.location,
    description = excluded.description,
    recurrence = excluded.recurrence,
    external_calendar_id = excluded.external_calendar_id,
    external_event_id = excluded.external_event_id,
    external_updated_at = excluded.external_updated_at,
    external_original_start_at = excluded.external_original_start_at,
    sync_status = 'active',
    cancelled_at = null;
  return new;
end $$;

revoke all on function public.monitor_calendar_reminder() from public, anon, authenticated;
grant execute on function public.monitor_calendar_reminder() to service_role;

-- Cloud leases coordinate repeated cron calls. Local workers do not schedule
-- sources explicitly owned by the cloud.
create or replace function public.monitor_cloud_claim(p_source uuid, p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.monitor_sources;
begin
  update public.monitor_sources
     set cloud_lease_until = now() + interval '2 minutes',
         last_attempt_at = now()
   where id = p_source and user_id = p_user and kind = 'calendar' and enabled
     and coalesce(config->>'sync_owner','local') = 'cloud'
     and (cloud_lease_until is null or cloud_lease_until < now())
   returning * into s;
  if not found then return null; end if;
  return to_jsonb(s);
end $$;

create or replace function public.monitor_cloud_complete(
  p_source uuid, p_user uuid, p_lease_until timestamptz,
  p_cursor jsonb, p_records_processed integer, p_result jsonb
) returns boolean
language sql security definer set search_path = public as $$
  update public.monitor_sources
     set cursor = coalesce(p_cursor, '{}'::jsonb),
         last_success_at = now(),
         records_processed = greatest(0, coalesce(p_records_processed, 0)),
         error_code = null,
         next_run_at = now() + make_interval(secs => interval_seconds),
         last_result = coalesce(p_result, '{}'::jsonb),
         cloud_lease_until = null
   where id = p_source and user_id = p_user and cloud_lease_until = p_lease_until
  returning true;
$$;

create or replace function public.monitor_cloud_fail(
  p_source uuid, p_user uuid, p_lease_until timestamptz,
  p_code text, p_result jsonb
) returns boolean
language sql security definer set search_path = public as $$
  update public.monitor_sources
     set error_code = case when p_code ~ '^[A-Z0-9_]{1,64}$' then p_code else 'UNKNOWN_ERROR' end,
         next_run_at = now() + make_interval(secs => interval_seconds),
         last_result = coalesce(p_result, '{}'::jsonb),
         cloud_lease_until = null
   where id = p_source and user_id = p_user and cloud_lease_until = p_lease_until
  returning true;
$$;

revoke all on function public.monitor_cloud_claim(uuid,uuid),
  public.monitor_cloud_complete(uuid,uuid,timestamptz,jsonb,integer,jsonb),
  public.monitor_cloud_fail(uuid,uuid,timestamptz,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.monitor_cloud_claim(uuid,uuid),
  public.monitor_cloud_complete(uuid,uuid,timestamptz,jsonb,integer,jsonb),
  public.monitor_cloud_fail(uuid,uuid,timestamptz,text,jsonb)
  to service_role;

-- Replace the scheduler/claimer with the same behavior plus cloud ownership.
create or replace function public.monitor_schedule(p_user uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
 insert into public.monitor_jobs(user_id,source_id,type)
 select user_id,id,'sync_'||kind from public.monitor_sources
 where enabled and user_id=p_user
   and coalesce(config->>'sync_owner','local') <> 'cloud'
   and next_run_at<=now()
 on conflict(source_id) where status in ('queued','running') do nothing;
end $$;

create or replace function public.monitor_claim(p_user uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare j public.monitor_jobs; s public.monitor_sources;
begin
 update public.monitor_runs r set status='expired',completed_at=now(),error_code='LEASE_EXPIRED'
 from public.monitor_jobs expired where r.job_id=expired.id and r.attempt=expired.attempts
 and expired.user_id=p_user and expired.status='running' and expired.lease_until<now() and r.status='running';
 update public.monitor_jobs set status='failed',completed_at=now(),error_code='LEASE_EXPIRED'
 where user_id=p_user and status='running' and lease_until<now() and attempts>=5;
 update public.monitor_sources src set next_run_at=now()+interval '1 hour',error_code='LEASE_EXPIRED'
 where src.user_id=p_user and exists(select 1 from public.monitor_jobs expired where expired.source_id=src.id
 and expired.status='failed' and expired.completed_at=now());
 select * into j from public.monitor_jobs
 where user_id=p_user and attempts<5 and ((status='queued' and run_at<=now()) or (status='running' and lease_until<now()))
 and exists(select 1 from public.monitor_sources src where src.id=source_id and src.enabled
   and coalesce(src.config->>'sync_owner','local') <> 'cloud')
 order by priority desc,run_at for update skip locked limit 1;
 if not found then return null; end if;
 update public.monitor_jobs set status='running',attempts=attempts+1,started_at=now(),
 lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',error_code=null
 where id=j.id returning * into j;
 update public.monitor_sources set last_attempt_at=now() where id=j.source_id returning * into s;
 insert into public.monitor_runs(job_id,user_id,attempt) values(j.id,j.user_id,j.attempts);
 return jsonb_build_object('job',to_jsonb(j),'source',to_jsonb(s));
end $$;

revoke all on function public.monitor_schedule(uuid), public.monitor_claim(uuid) from public, anon, authenticated;
grant execute on function public.monitor_schedule(uuid), public.monitor_claim(uuid) to service_role;

-- Vault-backed cron invocation. The migration is safe in local test databases
-- that do not have pg_cron/pg_net; on Supabase the job is created once and is
-- a no-op until the two Vault values are configured.
create or replace function public.invoke_google_calendar_sync()
returns bigint
language plpgsql security definer set search_path = public, vault, net as $$
declare
  endpoint text;
  sync_secret text;
  request_id bigint;
begin
  select decrypted_secret into endpoint from vault.decrypted_secrets
   where name = 'google_calendar_sync_url' limit 1;
  select decrypted_secret into sync_secret from vault.decrypted_secrets
   where name = 'google_calendar_sync_secret' limit 1;
  if coalesce(endpoint,'') = '' or coalesce(sync_secret,'') = '' then return null; end if;
  select net.http_post(
    url := endpoint,
    headers := jsonb_build_object('content-type','application/json','x-sync-secret',sync_secret),
    body := '{}'::jsonb
  ) into request_id;
  return request_id;
exception when undefined_table or undefined_function then
  return null;
end $$;
revoke all on function public.invoke_google_calendar_sync() from public, anon, authenticated;

do $$
begin
  if exists(select 1 from pg_available_extensions where name='pg_cron') then
    execute 'create extension if not exists pg_cron';
    execute $cron$
      select cron.schedule('google-calendar-sync', '*/5 * * * *', 'select public.invoke_google_calendar_sync()')
      where not exists (select 1 from cron.job where jobname = 'google-calendar-sync')
    $cron$;
  end if;
exception when undefined_table or undefined_function then
  null;
end $$;
