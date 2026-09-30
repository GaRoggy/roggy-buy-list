-- Cover the composite monitor_sources foreign key used by the queue trigger
-- and service-side reconciliation queries.
create index if not exists monitor_email_queue_source_owner
  on public.monitor_email_queue(source_id, user_id);
