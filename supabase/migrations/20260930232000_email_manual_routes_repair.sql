-- Manual Mail shelf decisions are owner-scoped route overrides. They remain
-- local to Roggy Lists and never write back to Gmail.
alter table public.monitor_email_queue
  add column if not exists manual_route text check (manual_route in ('dashboard','finance','mail','hidden')),
  add column if not exists manual_override boolean not null default false,
  add column if not exists manual_override_cache_key text,
  add column if not exists manual_override_at timestamptz;

create index if not exists monitor_email_queue_manual_override
  on public.monitor_email_queue(user_id, manual_override, updated_at desc)
  where manual_override = true;

create or replace function public.sync_monitor_email_queue() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p jsonb;
  next_route text;
  previous_route text;
  previous_manual_route text;
  previous_manual_override boolean;
  previous_manual_cache text;
  source_message text;
  cache_key text;
  keep_override boolean;
begin
  if new.kind <> 'email' then return new; end if;
  p := coalesce(new.payload, '{}'::jsonb);
  source_message := coalesce(nullif(p->>'source_message_id',''), new.external_id);
  cache_key := nullif(p->>'semantic_cache_key','');
  select route, manual_route, manual_override, manual_override_cache_key
    into previous_route, previous_manual_route, previous_manual_override, previous_manual_cache
    from public.monitor_email_queue where monitor_record_id = new.id;
  keep_override := coalesce(previous_manual_override, false)
    and previous_manual_route is not null
    and (previous_manual_cache is null or previous_manual_cache = cache_key);
  next_route := case
    when keep_override then previous_manual_route
    when new.status in ('deleted','needs_review') then 'hidden'
    when p->>'route' in ('dashboard','finance','mail','hidden') then p->>'route'
    when coalesce((p->>'dashboard') = 'true', false) then 'dashboard'
    else 'hidden'
  end;
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
           semantic_cache_key = cache_key,
           routing_version = coalesce(nullif(p->>'routing_version',''), 'email-routing-v3'),
           manual_route = case when keep_override then previous_manual_route else null end,
           manual_override = keep_override,
           manual_override_cache_key = case when keep_override then previous_manual_cache else null end,
           manual_override_at = case when keep_override then manual_override_at else null end,
           surfaced_at = case when next_route = 'hidden' then surfaced_at else coalesce(surfaced_at, now()) end,
           -- Reclassification never resurrects a dismissed item. Only an
           -- explicit user route action clears dismissal below.
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
      coalesce(nullif(p->>'semantic_status',''), 'deterministic'), cache_key,
      coalesce(nullif(p->>'routing_version',''), 'email-routing-v3'),
      case when next_route = 'hidden' then null else now() end, next_route
    );
  end if;
  return new;
end $$;

create or replace function public.set_monitor_email_route(p_queue_id uuid, p_route text, p_note text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  row_data public.monitor_email_queue%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_route not in ('dashboard','finance','mail','hidden') then raise exception 'INVALID_EMAIL_ROUTE'; end if;
  select * into row_data from public.monitor_email_queue
    where id = p_queue_id and user_id = auth.uid() for update;
  if not found then return false; end if;
  update public.monitor_email_queue
     set route = p_route,
         manual_route = p_route,
         manual_override = true,
         manual_override_cache_key = semantic_cache_key,
         manual_override_at = now(),
         dismissed_at = case when p_route = 'hidden' then coalesce(dismissed_at, now()) else null end,
         dismissed_from = case when p_route = 'hidden' then coalesce(dismissed_from, row_data.route) else null end,
         restored_at = case when p_route <> 'hidden' then now() else restored_at end,
         last_route = row_data.route,
         updated_at = now()
   where id = p_queue_id;
  insert into public.monitor_email_feedback(
    user_id, monitor_record_id, queue_id, source_message_id, from_route, to_route,
    label, note, classifier_version, routing_policy_version
  ) values (
    auth.uid(), row_data.monitor_record_id, row_data.id, row_data.source_message_id,
    row_data.route, p_route, jsonb_build_object('manual_route', true), left(p_note, 500),
    row_data.routing_version, row_data.routing_version
  );
  return true;
end $$;

revoke all on function public.set_monitor_email_route(uuid,text,text) from public, anon;
grant execute on function public.set_monitor_email_route(uuid,text,text) to authenticated;

-- Dismissal is also a local manual route decision. Keeping it attached to the
-- classifier cache key prevents a later monitor run from resurrecting the
-- message while still allowing a materially changed message to be reconsidered.
create or replace function public.dismiss_monitor_email(p_queue_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  row_data public.monitor_email_queue%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into row_data from public.monitor_email_queue
    where id = p_queue_id and user_id = auth.uid()
      and route in ('dashboard','finance','mail')
    for update;
  if not found then return false; end if;
  update public.monitor_email_queue
     set route = 'hidden',
         manual_route = 'hidden',
         manual_override = true,
         manual_override_cache_key = semantic_cache_key,
         manual_override_at = now(),
         dismissed_at = coalesce(dismissed_at, now()),
         dismissed_from = coalesce(dismissed_from, row_data.route),
         last_route = row_data.route,
         updated_at = now()
   where id = p_queue_id;
  insert into public.monitor_email_feedback(
    user_id, monitor_record_id, queue_id, source_message_id, from_route, to_route,
    label, note, classifier_version, routing_policy_version
  ) values (
    auth.uid(), row_data.monitor_record_id, row_data.id, row_data.source_message_id,
    row_data.route, 'hidden', jsonb_build_object('manual_route', true, 'dismissed', true),
    'Dismissed from Roggy Lists Mail shelf', row_data.routing_version, row_data.routing_version
  );
  return true;
end $$;

revoke all on function public.dismiss_monitor_email(uuid) from public, anon;
grant execute on function public.dismiss_monitor_email(uuid) to authenticated;

-- Restoring is an explicit reset of a local override. If there is no previous
-- visible route, the item returns to the uncertainty queue and is then eligible
-- for the normal automatic route on the next monitor update.
create or replace function public.restore_monitor_email(p_queue_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  row_data public.monitor_email_queue%rowtype;
  restored_route text;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into row_data from public.monitor_email_queue
    where id = p_queue_id and user_id = auth.uid()
    for update;
  if not found then return false; end if;
  restored_route := case when row_data.last_route in ('dashboard','finance','mail') then row_data.last_route else 'mail' end;
  update public.monitor_email_queue
     set route = restored_route,
         manual_route = null,
         manual_override = false,
         manual_override_cache_key = null,
         manual_override_at = null,
         dismissed_at = null,
         dismissed_from = null,
         restored_at = now(),
         updated_at = now()
   where id = p_queue_id;
  return true;
end $$;

revoke all on function public.restore_monitor_email(uuid) from public, anon;
grant execute on function public.restore_monitor_email(uuid) to authenticated;
