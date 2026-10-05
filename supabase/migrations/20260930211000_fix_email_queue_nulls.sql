-- Reapply the queue projection with fail-closed boolean handling for Gmail
-- records that are temporarily unavailable (needs_review) or deleted.
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
      coalesce((p->>'action_required') = 'true', false),
      coalesce((p->>'needs_reply') = 'true', false),
      coalesce((p->>'finance_related') = 'true', false),
      case when p->>'importance_score' ~ '^(0(\.\d+)?|1(\.\d+)?)$' then (p->>'importance_score')::numeric else 0 end,
      case when p->>'importance_confidence' ~ '^(0(\.\d+)?|1(\.\d+)?)$' then (p->>'importance_confidence')::numeric else 0 end,
      case when p->>'action_confidence' ~ '^(0(\.\d+)?|1(\.\d+)?)$' then (p->>'action_confidence')::numeric else 0 end,
      case when p->>'finance_confidence' ~ '^(0(\.\d+)?|1(\.\d+)?)$' then (p->>'finance_confidence')::numeric else 0 end,
      coalesce(nullif(p->>'routing_version',''), 'email-routing-v2'),
      case when next_route = 'hidden' then null else now() end, next_route
    );
  end if;
  return new;
end $$;
