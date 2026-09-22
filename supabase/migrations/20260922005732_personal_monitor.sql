-- Additive foundation. Existing tables and policies are not changed here.
create table public.monitor_sources (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 kind text not null check(kind in ('calendar','gmail','finance','garmin','brief')),
 external_id text not null,
 enabled boolean not null default false,
 interval_seconds integer not null default 300 check(interval_seconds >= 60),
 config jsonb not null default '{}',
 cursor jsonb not null default '{}',
 next_run_at timestamptz not null default now(),
 last_attempt_at timestamptz,
 last_success_at timestamptz,
 records_processed integer not null default 0,
 error_code text,
 unique(user_id,kind,external_id),
 unique(id,user_id)
);
create table public.monitor_records (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 source_id uuid not null,
 kind text not null,
 external_id text not null,
 occurred_at timestamptz,
 ingested_at timestamptz not null default now(),
 synced_at timestamptz not null default now(),
 status text not null default 'processed' check(status in ('processed','deleted','needs_review')),
 payload jsonb not null,
 unique(source_id,kind,external_id),
 foreign key(source_id,user_id) references public.monitor_sources(id,user_id)
);
create index monitor_records_owner_time on public.monitor_records(user_id,kind,occurred_at desc);
create table public.monitor_jobs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 source_id uuid not null,
 type text not null,
 status text not null default 'queued' check(status in ('queued','running','succeeded','failed')),
 priority integer not null default 0,
 created_at timestamptz not null default now(),
 run_at timestamptz not null default now(),
 started_at timestamptz,
 completed_at timestamptz,
 attempts integer not null default 0,
 lease_token uuid,
 lease_until timestamptz,
 error_code text,
 result jsonb,
 foreign key(source_id,user_id) references public.monitor_sources(id,user_id)
);
create unique index monitor_one_active_job on public.monitor_jobs(source_id) where status in ('queued','running');
create index monitor_job_claim on public.monitor_jobs(user_id,status,run_at,priority desc);
create table public.monitor_runs (
 id bigint generated always as identity primary key,
 job_id uuid not null references public.monitor_jobs(id),
 user_id uuid not null references auth.users(id),
 attempt integer not null,
 started_at timestamptz not null default now(),
 completed_at timestamptz,
 status text not null default 'running',
 error_code text,
 records_processed integer not null default 0,
 unique(job_id,attempt)
);
create index monitor_runs_owner on public.monitor_runs(user_id,started_at desc);

-- No client can schedule work or supply provider payloads. Owner SELECT only.
do $$ declare t text; begin
 foreach t in array array['monitor_sources','monitor_records','monitor_jobs','monitor_runs'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid())=user_id)',t);
 end loop;
end $$;
grant usage, select on sequence public.monitor_runs_id_seq to service_role;

create function public.monitor_schedule(p_user uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
 insert into public.monitor_jobs(user_id,source_id,type)
 select user_id,id,'sync_'||kind from public.monitor_sources
 where enabled and user_id=p_user and next_run_at<=now()
 on conflict(source_id) where status in ('queued','running') do nothing;
end $$;

create function public.monitor_claim(p_user uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare j public.monitor_jobs; s public.monitor_sources;
begin
 -- A bounded number of abandoned attempts; retain history of crashes.
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
 and exists(select 1 from public.monitor_sources src where src.id=source_id and src.enabled)
 order by priority desc,run_at for update skip locked limit 1;
 if not found then return null; end if;
 update public.monitor_jobs set status='running',attempts=attempts+1,started_at=now(),
 lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',error_code=null
 where id=j.id returning * into j;
 update public.monitor_sources set last_attempt_at=now() where id=j.source_id returning * into s;
 insert into public.monitor_runs(job_id,user_id,attempt) values(j.id,j.user_id,j.attempts);
 return jsonb_build_object('job',to_jsonb(j),'source',to_jsonb(s));
end $$;

create function public.monitor_heartbeat(p_job uuid,p_token uuid) returns boolean
language sql security invoker set search_path = '' as $$
 with renewed as (update public.monitor_jobs set lease_until=now()+interval '2 minutes'
 where id=p_job and lease_token=p_token and status='running' and lease_until>now() returning id)
 select exists(select 1 from renewed);
$$;

create function public.monitor_commit(p_job uuid,p_token uuid,p_records jsonb,p_cursor jsonb) returns integer
language plpgsql security invoker set search_path = '' as $$
declare j public.monitor_jobs; r jsonb; n integer=0;
begin
 select * into j from public.monitor_jobs where id=p_job for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_token or j.lease_until<=now() then
  raise exception 'STALE_LEASE';
 end if;
 if jsonb_typeof(p_records)<>'array' then raise exception 'INVALID_RECORDS'; end if;
 for r in select value from jsonb_array_elements(p_records) loop
  if coalesce(r->>'external_id','')='' or coalesce(r->>'kind','')='' then raise exception 'INVALID_RECORD'; end if;
  insert into public.monitor_records(user_id,source_id,kind,external_id,occurred_at,status,payload)
  values(j.user_id,j.source_id,r->>'kind',r->>'external_id',(r->>'occurred_at')::timestamptz,
   coalesce(r->>'status','processed'),coalesce(r->'payload','{}'))
  on conflict(source_id,kind,external_id) do update set occurred_at=excluded.occurred_at,
   status=excluded.status,payload=excluded.payload,synced_at=now();
  n=n+1;
 end loop;
 update public.monitor_sources set cursor=p_cursor,last_success_at=now(),records_processed=n,error_code=null,
 next_run_at=now()+make_interval(secs=>interval_seconds) where id=j.source_id;
 update public.monitor_jobs set status='succeeded',completed_at=now(),lease_until=null,
 result=jsonb_build_object('records_processed',n) where id=j.id;
 update public.monitor_runs set status='succeeded',completed_at=now(),records_processed=n
 where job_id=j.id and attempt=j.attempts;
 return n;
end $$;

create function public.monitor_fail(p_job uuid,p_token uuid,p_code text,p_delay integer,p_terminal boolean) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare j public.monitor_jobs; terminal boolean;
begin
 select * into j from public.monitor_jobs where id=p_job for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_token or j.lease_until<=now() then return false; end if;
 -- Codes only: do not persist provider bodies or exception messages.
 if p_code !~ '^[A-Z0-9_]{1,64}$' then p_code='UNKNOWN_ERROR'; end if;
 terminal=p_terminal or j.attempts>=5;
 update public.monitor_jobs set status=case when terminal then 'failed' else 'queued' end,
 run_at=now()+make_interval(secs=>greatest(1,least(p_delay,86400))),lease_until=null,
 completed_at=case when terminal then now() else null end,error_code=p_code where id=j.id;
 update public.monitor_runs set status='failed',completed_at=now(),error_code=p_code where job_id=j.id and attempt=j.attempts;
 update public.monitor_sources set error_code=p_code,next_run_at=now()+interval '1 hour',
 enabled=case when p_terminal then false else enabled end where id=j.source_id;
 return true;
end $$;

revoke all on function public.monitor_schedule(uuid),public.monitor_claim(uuid),public.monitor_heartbeat(uuid,uuid),
 public.monitor_commit(uuid,uuid,jsonb,jsonb),public.monitor_fail(uuid,uuid,text,integer,boolean) from public,anon,authenticated;
grant execute on function public.monitor_schedule(uuid),public.monitor_claim(uuid),public.monitor_heartbeat(uuid,uuid),
 public.monitor_commit(uuid,uuid,jsonb,jsonb),public.monitor_fail(uuid,uuid,text,integer,boolean) to service_role;
