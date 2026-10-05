-- Independent semantic evidence and confidence for Gmail routing. The
-- provider payload remains the source of truth; this bounded projection is
-- safe for owner-scoped review and calibration.
alter table public.monitor_email_queue
  add column if not exists reply_confidence numeric(4,3) not null default 0 check (reply_confidence between 0 and 1),
  add column if not exists low_value boolean not null default false,
  add column if not exists low_value_confidence numeric(4,3) not null default 0 check (low_value_confidence between 0 and 1),
  add column if not exists route_confidence numeric(4,3) not null default 0 check (route_confidence between 0 and 1),
  add column if not exists ambiguity_reason jsonb not null default '[]'::jsonb check (jsonb_typeof(ambiguity_reason) = 'array'),
  add column if not exists semantic_version text not null default 'unknown',
  add column if not exists semantic_model_version text not null default 'none',
  add column if not exists semantic_status text not null default 'deterministic',
  add column if not exists semantic_cache_key text;

create index if not exists monitor_email_queue_confidence
  on public.monitor_email_queue(user_id, route, route_confidence desc, occurred_at desc);

create or replace function public.sync_monitor_email_queue() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p jsonb;
  next_route text;
  previous_route text;
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
  select route into previous_route from public.monitor_email_queue where monitor_record_id = new.id;
  if found then
    update public.monitor_email_queue
       set source_id = new.source_id, source_message_id = source_message,
           thread_id = nullif(p->>'thread_id',''), route = next_route,
           category = nullif(p->>'category',''), sender = nullif(p->>'sender',''),
           subject = nullif(p->>'subject',''), summary = nullif(p->>'summary',''),
           reason = nullif(p->>'reason',''), occurred_at = new.occurred_at,
           action_required = coalesce((p->>'action_required') = 'true', false),
           needs_reply = coalesce((p->>'needs_reply') = 'true', false),
           finance_related = coalesce((p->>'finance_related') = 'true', false),
           importance_score = case when p->>'importance_score' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'importance_score')::numeric else 0 end,
           importance_confidence = case when p->>'importance_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'importance_confidence')::numeric else 0 end,
           action_confidence = case when p->>'action_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'action_confidence')::numeric else 0 end,
           reply_confidence = case when p->>'reply_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'reply_confidence')::numeric else 0 end,
           finance_confidence = case when p->>'finance_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'finance_confidence')::numeric else 0 end,
           low_value = coalesce((p->>'low_value') = 'true', false),
           low_value_confidence = case when p->>'low_value_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'low_value_confidence')::numeric else 0 end,
           route_confidence = case when p->>'route_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'route_confidence')::numeric else 0 end,
           ambiguity_reason = case when jsonb_typeof(p->'ambiguity_reason') = 'array' then p->'ambiguity_reason' else '[]'::jsonb end,
           semantic_version = coalesce(nullif(p->>'semantic_version',''), 'unknown'),
           semantic_model_version = coalesce(nullif(p->>'semantic_model_version',''), 'none'),
           semantic_status = coalesce(nullif(p->>'semantic_status',''), 'deterministic'),
           semantic_cache_key = nullif(p->>'semantic_cache_key',''),
           routing_version = coalesce(nullif(p->>'routing_version',''), 'email-routing-v3'),
           surfaced_at = case when next_route = 'hidden' then surfaced_at else coalesce(surfaced_at, now()) end,
           -- Reclassification is evidence, not a user restore action. Keep a
           -- prior dismissal until the user explicitly restores the message.
           dismissed_at = dismissed_at,
           dismissed_from = dismissed_from,
           restored_at = restored_at,
           last_route = case when previous_route is distinct from next_route then previous_route else last_route end,
           updated_at = now()
     where monitor_record_id = new.id;
  else
    insert into public.monitor_email_queue(
      user_id, monitor_record_id, source_id, source_message_id, thread_id, route,
      category, sender, subject, summary, reason, occurred_at, action_required,
      needs_reply, finance_related, importance_score, importance_confidence,
      action_confidence, reply_confidence, finance_confidence, low_value,
      low_value_confidence, route_confidence, ambiguity_reason, semantic_version,
      semantic_model_version, semantic_status, semantic_cache_key, routing_version, surfaced_at, last_route
    ) values (
      new.user_id, new.id, new.source_id, source_message, nullif(p->>'thread_id',''), next_route,
      nullif(p->>'category',''), nullif(p->>'sender',''), nullif(p->>'subject',''),
      nullif(p->>'summary',''), nullif(p->>'reason',''), new.occurred_at,
      coalesce((p->>'action_required') = 'true', false), coalesce((p->>'needs_reply') = 'true', false),
      coalesce((p->>'finance_related') = 'true', false),
      case when p->>'importance_score' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'importance_score')::numeric else 0 end,
      case when p->>'importance_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'importance_confidence')::numeric else 0 end,
      case when p->>'action_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'action_confidence')::numeric else 0 end,
      case when p->>'reply_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'reply_confidence')::numeric else 0 end,
      case when p->>'finance_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'finance_confidence')::numeric else 0 end,
      coalesce((p->>'low_value') = 'true', false),
      case when p->>'low_value_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'low_value_confidence')::numeric else 0 end,
      case when p->>'route_confidence' ~ '^(0(\.\d+)?|1(\.0+)?)$' then (p->>'route_confidence')::numeric else 0 end,
      case when jsonb_typeof(p->'ambiguity_reason') = 'array' then p->'ambiguity_reason' else '[]'::jsonb end,
      coalesce(nullif(p->>'semantic_version',''), 'unknown'), coalesce(nullif(p->>'semantic_model_version',''), 'none'),
      coalesce(nullif(p->>'semantic_status',''), 'deterministic'), nullif(p->>'semantic_cache_key',''),
      coalesce(nullif(p->>'routing_version',''), 'email-routing-v3'),
      case when next_route = 'hidden' then null else now() end, next_route
    );
  end if;
  return new;
end $$;

-- Feedback is append-only evidence. A correction changes future calibration;
-- it does not retroactively or globally override every message.
create table if not exists public.monitor_email_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  monitor_record_id uuid references public.monitor_records(id) on delete set null,
  queue_id uuid references public.monitor_email_queue(id) on delete set null,
  source_message_id text not null,
  from_route text check (from_route in ('dashboard','finance','mail','hidden')),
  to_route text not null check (to_route in ('dashboard','finance','mail','hidden')),
  label jsonb not null default '{}'::jsonb check (jsonb_typeof(label) = 'object'),
  note text check (char_length(note) <= 500),
  classifier_version text,
  routing_policy_version text,
  created_at timestamptz not null default now()
);

create index if not exists monitor_email_feedback_owner_time
  on public.monitor_email_feedback(user_id, created_at desc);
create index if not exists monitor_email_feedback_message
  on public.monitor_email_feedback(user_id, source_message_id, created_at desc);

alter table public.monitor_email_feedback enable row level security;
revoke all on public.monitor_email_feedback from anon, authenticated;
grant select, insert on public.monitor_email_feedback to authenticated;
grant all on public.monitor_email_feedback to service_role;
drop policy if exists monitor_email_feedback_owner_read on public.monitor_email_feedback;
create policy monitor_email_feedback_owner_read on public.monitor_email_feedback
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists monitor_email_feedback_owner_insert on public.monitor_email_feedback;
create policy monitor_email_feedback_owner_insert on public.monitor_email_feedback
  for insert to authenticated with check ((select auth.uid()) = user_id);

create or replace function public.record_monitor_email_feedback(
  p_source_message_id text, p_from_route text, p_to_route text, p_label jsonb default '{}'::jsonb, p_note text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare result_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  insert into public.monitor_email_feedback(user_id, source_message_id, from_route, to_route, label, note)
  values (auth.uid(), left(p_source_message_id, 200), p_from_route, p_to_route,
    case when jsonb_typeof(coalesce(p_label, '{}'::jsonb)) = 'object' then p_label else '{}'::jsonb end,
    left(p_note, 500)) returning id into result_id;
  return result_id;
end $$;
revoke all on function public.record_monitor_email_feedback(text,text,text,jsonb,text) from public, anon;
grant execute on function public.record_monitor_email_feedback(text,text,text,jsonb,text) to authenticated;
