-- Cover the composite owner/source foreign keys used by the Google projections.
create index if not exists monitor_google_tasks_source_owner on public.monitor_google_tasks(source_id,user_id);
create index if not exists monitor_google_people_source_owner on public.monitor_google_people(source_id,user_id);
create index if not exists monitor_google_drive_files_source_owner on public.monitor_google_drive_files(source_id,user_id);
