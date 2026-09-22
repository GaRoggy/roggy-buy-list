-- Adopt legacy links even when the first received event is cancelled.
create or replace function public.monitor_calendar_reminder() returns trigger
language plpgsql security invoker set search_path='' as $$
declare p jsonb; legacy uuid; start_time timestamptz; end_time timestamptz;
begin
 if new.kind<>'calendar_event' then return new; end if;
 -- Adopt an exact legacy event ID belonging to this owner, preserving its UUID.
 select id into legacy from public.reminders where user_id=new.user_id and source='google_calendar'
 and external_id=new.external_id and monitor_record_id is null;
 if legacy is not null then
  update public.reminders set monitor_record_id=new.id,external_id='monitor:'||new.source_id||':'||new.external_id where id=legacy;
 end if;
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
 insert into public.reminders(user_id,monitor_record_id,title,start_at,end_at,all_day,start_date,end_date,source,external_id)
 values(new.user_id,new.id,p->>'title',start_time,end_time,(p->>'all_day')::boolean,
 case when (p->>'all_day')::boolean then (p->>'start')::date end,
 case when (p->>'all_day')::boolean then (p->>'end')::date end,'google_calendar','monitor:'||new.source_id||':'||new.external_id)
 on conflict(monitor_record_id) do update set title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,
 all_day=excluded.all_day,start_date=excluded.start_date,end_date=excluded.end_date,cancelled_at=null;
 return new;
end $$;
