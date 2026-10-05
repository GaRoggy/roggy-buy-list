-- Cover the composite source ownership foreign key used by monitor_events.
create index monitor_events_source_owner on public.monitor_events(source_id, user_id);
