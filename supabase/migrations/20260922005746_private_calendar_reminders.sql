-- Preserve all existing reminders. Abort rather than guess ownership.
alter table public.reminders add column user_id uuid references auth.users(id);
alter table public.reminders add column monitor_record_id uuid unique references public.monitor_records(id);
alter table public.reminders add column start_date date;
alter table public.reminders add column end_date date;
alter table public.reminders add column cancelled_at timestamptz;
do $$ declare owner_id uuid; n integer; p record; begin
 select count(distinct user_id) into n from public.budget_entries;
 if n<>1 then raise exception 'REMINDER_OWNER_REQUIRES_EXPLICIT_MAPPING'; end if;
 select distinct user_id into owner_id from public.budget_entries;
 update public.reminders set user_id=owner_id;
 for p in select policyname from pg_policies where schemaname='public' and tablename='reminders' loop
  execute format('drop policy %I on public.reminders',p.policyname);
 end loop;
end $$;
alter table public.reminders alter column user_id set not null;
alter table public.reminders alter column user_id set default auth.uid();
alter table public.reminders enable row level security;
revoke all on public.reminders from anon,authenticated;
grant select,insert,update,delete on public.reminders to authenticated;
grant all on public.reminders to service_role;
create index reminders_owner_start on public.reminders(user_id,start_at);
create policy reminder_read on public.reminders for select to authenticated using((select auth.uid())=user_id);
create policy reminder_insert on public.reminders for insert to authenticated with check((select auth.uid())=user_id and source='manual' and monitor_record_id is null);
-- Imported reminders are controlled by the collector. Manual reminders remain editable.
create policy reminder_update on public.reminders for update to authenticated using((select auth.uid())=user_id and source='manual') with check((select auth.uid())=user_id and source='manual' and monitor_record_id is null);
create policy reminder_delete on public.reminders for delete to authenticated using((select auth.uid())=user_id and source='manual');

create function public.monitor_calendar_reminder() returns trigger
language plpgsql security invoker set search_path='' as $$
declare p jsonb; legacy uuid; start_time timestamptz; end_time timestamptz;
begin
 if new.kind<>'calendar_event' then return new; end if;
 if new.status='deleted' then
  update public.reminders set cancelled_at=now() where monitor_record_id=new.id;
  return new;
 end if;
 p=new.payload;
 if (p->>'all_day')::boolean then
  start_time=(p->>'start')::date::timestamp at time zone coalesce(p->>'time_zone','America/Chicago');
  end_time=(p->>'end')::date::timestamp at time zone coalesce(p->>'time_zone','America/Chicago');
 else start_time=(p->>'start')::timestamptz; end_time=(p->>'end')::timestamptz;
 end if;
 -- Adopt an exact legacy event ID belonging to this owner, preserving its UUID.
 select id into legacy from public.reminders where user_id=new.user_id and source='google_calendar'
 and external_id=new.external_id and monitor_record_id is null;
 if legacy is not null then
  update public.reminders set monitor_record_id=new.id,external_id='monitor:'||new.source_id||':'||new.external_id where id=legacy;
 end if;
 insert into public.reminders(user_id,monitor_record_id,title,start_at,end_at,all_day,start_date,end_date,source,external_id)
 values(new.user_id,new.id,p->>'title',start_time,end_time,(p->>'all_day')::boolean,
 case when (p->>'all_day')::boolean then (p->>'start')::date end,
 case when (p->>'all_day')::boolean then (p->>'end')::date end,'google_calendar','monitor:'||new.source_id||':'||new.external_id)
 on conflict(monitor_record_id) do update set title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,
 all_day=excluded.all_day,start_date=excluded.start_date,end_date=excluded.end_date,cancelled_at=null;
 return new;
end $$;
revoke all on function public.monitor_calendar_reminder() from public,anon,authenticated;
grant execute on function public.monitor_calendar_reminder() to service_role;
create trigger monitor_calendar_reminder after insert or update on public.monitor_records
for each row execute function public.monitor_calendar_reminder();
