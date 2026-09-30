-- Deterministic, finite Gmail action queues. Raw provider records remain in
-- monitor_records; this table stores only bounded display metadata and queue
-- state owned by the same user.
create table if not exists public.monitor_email_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  monitor_record_id uuid not null unique references public.monitor_records(id) on delete cascade,
  source_id uuid not null,
  source_message_id text not null,
  thread_id text,
  route text not null check (route in ('dashboard','finance','mail','hidden')),
  category text,
  sender text,
  subject text,
  summary text,
  reason text,
  occurred_at timestamptz,
  action_required boolean not null default false,
  needs_reply boolean not null default false,
  finance_related boolean not null default false,
  importance_score numeric(4,3) not null default 0 check (importance_score between 0 and 1),
  importance_confidence numeric(4,3) not null default 0 check (importance_confidence between 0 and 1),
  action_confidence numeric(4,3) not null default 0 check (action_confidence between 0 and 1),
  finance_confidence numeric(4,3) not null default 0 check (finance_confidence between 0 and 1),
  routing_version text not null default 'email-routing-v2',
  surfaced_at timestamptz,
  dismissed_at timestamptz,
  dismissed_from text check (dismissed_from in ('dashboard','finance','mail')),
  restored_at timestamptz,
  last_route text check (last_route in ('dashboard','finance','mail','hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (source_id, user_id) references public.monitor_sources(id, user_id),
  unique (user_id, source_id, source_message_id)
);

create index if not exists monitor_email_queue_visible
  on public.monitor_email_queue(user_id, route, occurred_at desc)
  where dismissed_at is null and route <> 'hidden';
create index if not exists monitor_email_queue_record
  on public.monitor_email_queue(user_id, monitor_record_id);

alter table public.monitor_email_queue enable row level security;
revoke all on public.monitor_email_queue from anon, authenticated;
grant select on public.monitor_email_queue to authenticated;
grant all on public.monitor_email_queue to service_role;
create policy monitor_email_queue_owner_read on public.monitor_email_queue
  for select to authenticated using ((select auth.uid()) = user_id);

-- Provider commits are the only way queue rows are created or classified.
create or replace function public.sync_monitor_email_queue() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p jsonb;
  next_route text;
  previous_route text;
  previous_dismissed timestamptz;
  source_message text;
begin
  if new.kind <> 'email' then return new; end if;
  p := coalesce(new.payload, '{}'::jsonb);
  next_route := case
    when new.status in ('deleted','needs_review') then 'hidden'
    when p->>'route' in ('dashboard','finance','mail','hidden') then p->>'route'
    when coalesce((p->>'dashboard') = 'true', false) then 'dashboard'
    else 'hidden'
  end;
  source_message := coalesce(nullif(p->>'source_message_id',''), new.external_id);
  select route, dismissed_at into previous_route, previous_dismissed
    from public.monitor_email_queue where monitor_record_id = new.id;

  if found then
    update public.monitor_email_queue
       set source_id = new.source_id,
           source_message_id = source_message,
           thread_id = nullif(p->>'thread_id',''),
           route = next_route,
           category = nullif(p->>'category',''),
           sender = nullif(p->>'sender',''),
           subject = nullif(p->>'subject',''),
           summary = nullif(p->>'summary',''),
           reason = nullif(p->>'reason',''),
           occurred_at = new.occurred_at,
           action_required = coalesce((p->>'action_required') = 'true', false),
           needs_reply = coalesce((p->>'needs_reply') = 'true', false),
           finance_related = coalesce((p->>'finance_related') = 'true', false),
           importance_score = case when p->>'importance_score' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'importance_score')::numeric else 0 end,
           importance_confidence = case when p->>'importance_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'importance_confidence')::numeric else 0 end,
           action_confidence = case when p->>'action_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'action_confidence')::numeric else 0 end,
           finance_confidence = case when p->>'finance_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'finance_confidence')::numeric else 0 end,
           routing_version = coalesce(nullif(p->>'routing_version',''), 'email-routing-v2'),
           surfaced_at = case when next_route = 'hidden' then surfaced_at else coalesce(surfaced_at, now()) end,
           dismissed_at = case when previous_route is distinct from next_route then null else dismissed_at end,
           dismissed_from = case when previous_route is distinct from next_route then null else dismissed_from end,
           restored_at = case when previous_route is distinct from next_route then now() else restored_at end,
           last_route = case when previous_route is distinct from next_route then previous_route else last_route end,
           updated_at = now()
     where monitor_record_id = new.id;
  else
    insert into public.monitor_email_queue(
      user_id, monitor_record_id, source_id, source_message_id, thread_id, route,
      category, sender, subject, summary, reason, occurred_at, action_required,
      needs_reply, finance_related, importance_score, importance_confidence,
      action_confidence, finance_confidence, routing_version, surfaced_at, last_route
    ) values (
      new.user_id, new.id, new.source_id, source_message, nullif(p->>'thread_id',''), next_route,
      nullif(p->>'category',''), nullif(p->>'sender',''), nullif(p->>'subject',''),
      nullif(p->>'summary',''), nullif(p->>'reason',''), new.occurred_at,
      coalesce((p->>'action_required') = 'true', false), coalesce((p->>'needs_reply') = 'true', false),
      coalesce((p->>'finance_related') = 'true', false),
      case when p->>'importance_score' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'importance_score')::numeric else 0 end,
      case when p->>'importance_confidence' ~ '^(0(\.\d+)?|1(\.\d+)?)$' then (p->>'importance_confidence')::numeric else 0 end,
      case when p->>'action_confidence' ~ '^(0(\.\d+)?|1(\.\d+)?)$' then (p->>'action_confidence')::numeric else 0 end,
      case when p->>'finance_confidence' ~ '^(0(\.\d+)?|1(\.\d+)?)$' then (p->>'finance_confidence')::numeric else 0 end,
      coalesce(nullif(p->>'routing_version',''), 'email-routing-v2'),
      case when next_route = 'hidden' then null else now() end, next_route
    );
  end if;
  return new;
end $$;

revoke all on function public.sync_monitor_email_queue() from public, anon, authenticated;
grant execute on function public.sync_monitor_email_queue() to service_role;
drop trigger if exists monitor_email_queue_projection on public.monitor_records;
create trigger monitor_email_queue_projection after insert or update on public.monitor_records
for each row execute function public.sync_monitor_email_queue();

-- Seed existing records safely. A subsequent Gmail bootstrap reclassifies the
-- message payloads with the current deterministic router.
insert into public.monitor_email_queue(user_id, monitor_record_id, source_id, source_message_id, route,
  category, sender, subject, summary, reason, occurred_at, surfaced_at, last_route)
select r.user_id, r.id, r.source_id, coalesce(nullif(r.payload->>'source_message_id',''), r.external_id),
  case when coalesce((r.payload->>'dashboard') = 'true', false) then 'dashboard' else 'hidden' end,
  nullif(r.payload->>'category',''), nullif(r.payload->>'sender',''), nullif(r.payload->>'subject',''),
  nullif(r.payload->>'summary',''), nullif(r.payload->>'reason',''), r.occurred_at,
  case when coalesce((r.payload->>'dashboard') = 'true', false) then now() else null end,
  case when coalesce((r.payload->>'dashboard') = 'true', false) then 'dashboard' else 'hidden' end
from public.monitor_records r
where r.kind = 'email'
on conflict (monitor_record_id) do nothing;

create or replace function public.dismiss_monitor_email(p_queue_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.monitor_email_queue
     set dismissed_at = coalesce(dismissed_at, now()),
         dismissed_from = coalesce(dismissed_from, route),
         updated_at = now()
   where id = p_queue_id and user_id = auth.uid() and route in ('dashboard','finance','mail');
  return found;
end $$;

create or replace function public.restore_monitor_email(p_queue_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.monitor_email_queue
     set dismissed_at = null, dismissed_from = null, restored_at = now(), updated_at = now()
   where id = p_queue_id and user_id = auth.uid();
  return found;
end $$;

revoke all on function public.dismiss_monitor_email(uuid), public.restore_monitor_email(uuid)
  from public, anon;
grant execute on function public.dismiss_monitor_email(uuid), public.restore_monitor_email(uuid)
  to authenticated;
