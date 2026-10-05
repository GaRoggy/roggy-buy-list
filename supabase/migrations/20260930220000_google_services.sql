-- Additive Google Tasks, People and Drive metadata projections.
-- Provider records remain the source of truth; these tables are indexed, owner-scoped views.
alter table public.monitor_sources drop constraint if exists monitor_sources_kind_check;
alter table public.monitor_sources add constraint monitor_sources_kind_check
  check (kind in ('calendar','gmail','finance','garmin','brief','smart_home','google_tasks','google_people','google_drive'));

create table if not exists public.monitor_google_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  source_id uuid not null,
  external_list_id text not null,
  external_task_id text not null,
  title text not null,
  notes text,
  due_at timestamptz,
  completed boolean not null default false,
  completed_at timestamptz,
  parent_external_id text,
  external_updated_at timestamptz,
  web_view_link text,
  sync_status text not null default 'active' check (sync_status in ('active','completed','deleted')),
  synced_at timestamptz not null default now(),
  unique(user_id, source_id, external_list_id, external_task_id),
  foreign key(source_id,user_id) references public.monitor_sources(id,user_id)
);
create index if not exists monitor_google_tasks_due on public.monitor_google_tasks(user_id,due_at) where sync_status='active';
create index if not exists monitor_google_tasks_title on public.monitor_google_tasks using gin(to_tsvector('simple', title));

create table if not exists public.monitor_google_people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  source_id uuid not null,
  external_person_id text not null,
  canonical_name text not null,
  aliases text[] not null default '{}',
  emails text[] not null default '{}',
  phones text[] not null default '{}',
  organization text,
  job_title text,
  metadata jsonb not null default '{}',
  sync_status text not null default 'active' check (sync_status in ('active','deleted')),
  synced_at timestamptz not null default now(),
  unique(user_id, source_id, external_person_id),
  foreign key(source_id,user_id) references public.monitor_sources(id,user_id)
);
create index if not exists monitor_google_people_name on public.monitor_google_people(user_id,canonical_name);
create index if not exists monitor_google_people_emails on public.monitor_google_people using gin(emails);

create table if not exists public.monitor_google_drive_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  source_id uuid not null,
  external_file_id text not null,
  name text not null,
  mime_type text,
  modified_at timestamptz,
  created_at timestamptz,
  parent_ids text[] not null default '{}',
  owner_name text,
  owner_email text,
  web_view_link text,
  can_download boolean not null default false,
  sync_status text not null default 'active' check (sync_status in ('active','deleted')),
  metadata jsonb not null default '{}',
  synced_at timestamptz not null default now(),
  unique(user_id, source_id, external_file_id),
  foreign key(source_id,user_id) references public.monitor_sources(id,user_id)
);
create index if not exists monitor_google_drive_files_name on public.monitor_google_drive_files(user_id,name);
create index if not exists monitor_google_drive_files_modified on public.monitor_google_drive_files(user_id,modified_at desc) where sync_status='active';
create index if not exists monitor_google_drive_files_mime on public.monitor_google_drive_files(user_id,mime_type);

do $$ declare t text; begin
 foreach t in array array['monitor_google_tasks','monitor_google_people','monitor_google_drive_files'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid())=user_id)',t);
 end loop;
end $$;

create or replace function public.monitor_safe_timestamptz(value text) returns timestamptz
language plpgsql immutable set search_path = public as $$
begin
  if value is null or btrim(value) = '' then return null; end if;
  return value::timestamptz;
exception when others then return null;
end $$;
revoke all on function public.monitor_safe_timestamptz(text) from public,anon,authenticated;
grant execute on function public.monitor_safe_timestamptz(text) to service_role;

create or replace function public.monitor_safe_boolean(value text) returns boolean
language plpgsql immutable set search_path = public as $$
begin
  if value is null or btrim(value) = '' then return false; end if;
  return value::boolean;
exception when others then return false;
end $$;
revoke all on function public.monitor_safe_boolean(text) from public,anon,authenticated;
grant execute on function public.monitor_safe_boolean(text) to service_role;

create or replace function public.project_google_service_record() returns trigger
language plpgsql set search_path = public as $$
declare p jsonb := coalesce(new.payload,'{}'::jsonb); source_kind text;
begin
 select kind into source_kind from public.monitor_sources where id=new.source_id and user_id=new.user_id;
 if new.kind='google_task' or source_kind='google_tasks' then
   insert into public.monitor_google_tasks(user_id,source_id,external_list_id,external_task_id,title,notes,due_at,completed,completed_at,parent_external_id,external_updated_at,web_view_link,sync_status,synced_at)
   values(new.user_id,new.source_id,coalesce(p->>'list_id','unknown'),coalesce(p->>'task_id',new.external_id),coalesce(p->>'title','(Untitled task)'),p->>'notes',public.monitor_safe_timestamptz(p->>'due'),public.monitor_safe_boolean(p->>'completed'),public.monitor_safe_timestamptz(p->>'completed_at'),p->>'parent',public.monitor_safe_timestamptz(p->>'updated'),p->>'web_view_link',case when new.status='deleted' then 'deleted' when public.monitor_safe_boolean(p->>'completed') then 'completed' else 'active' end,now())
   on conflict(user_id,source_id,external_list_id,external_task_id) do update set title=excluded.title,notes=excluded.notes,due_at=excluded.due_at,completed=excluded.completed,completed_at=excluded.completed_at,parent_external_id=excluded.parent_external_id,external_updated_at=excluded.external_updated_at,web_view_link=excluded.web_view_link,sync_status=excluded.sync_status,synced_at=now();
 elsif new.kind='google_person' or source_kind='google_people' then
   insert into public.monitor_google_people(user_id,source_id,external_person_id,canonical_name,aliases,emails,phones,organization,job_title,metadata,sync_status,synced_at)
   values(new.user_id,new.source_id,coalesce(p->>'resource_name',new.external_id),coalesce(p->>'canonical_name',new.external_id),coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'aliases','[]'::jsonb))), '{}'),coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'emails','[]'::jsonb))), '{}'),coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'phones','[]'::jsonb))), '{}'),p->>'organization',p->>'job_title',coalesce(p->'metadata','{}'::jsonb),case when new.status='deleted' then 'deleted' else 'active' end,now())
   on conflict(user_id,source_id,external_person_id) do update set canonical_name=excluded.canonical_name,aliases=excluded.aliases,emails=excluded.emails,phones=excluded.phones,organization=excluded.organization,job_title=excluded.job_title,metadata=excluded.metadata,sync_status=excluded.sync_status,synced_at=now();
 elsif new.kind='google_drive_file' or source_kind='google_drive' then
   insert into public.monitor_google_drive_files(user_id,source_id,external_file_id,name,mime_type,modified_at,created_at,parent_ids,owner_name,owner_email,web_view_link,can_download,sync_status,metadata,synced_at)
   values(new.user_id,new.source_id,coalesce(p->>'file_id',new.external_id),coalesce(p->>'name','(Unnamed file)'),p->>'mime_type',public.monitor_safe_timestamptz(p->>'modified_time'),public.monitor_safe_timestamptz(p->>'created_time'),coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'parent_ids','[]'::jsonb))), '{}'),p#>>'{owner,name}',p#>>'{owner,email}',p->>'web_view_link',public.monitor_safe_boolean(p->>'can_download'),case when new.status='deleted' then 'deleted' else 'active' end,jsonb_build_object('trashed',public.monitor_safe_boolean(p->>'trashed')),now())
   on conflict(user_id,source_id,external_file_id) do update set name=excluded.name,mime_type=excluded.mime_type,modified_at=excluded.modified_at,created_at=excluded.created_at,parent_ids=excluded.parent_ids,owner_name=excluded.owner_name,owner_email=excluded.owner_email,web_view_link=excluded.web_view_link,can_download=excluded.can_download,sync_status=excluded.sync_status,metadata=excluded.metadata,synced_at=now();
 end if;
 return new;
end $$;

drop trigger if exists monitor_google_service_projection on public.monitor_records;
create trigger monitor_google_service_projection after insert or update on public.monitor_records
for each row execute function public.project_google_service_record();
revoke all on function public.project_google_service_record() from public,anon,authenticated;
grant execute on function public.project_google_service_record() to service_role;
