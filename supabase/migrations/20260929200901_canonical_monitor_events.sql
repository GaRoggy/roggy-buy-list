-- Canonical, source-agnostic event projection for the existing monitor pipeline.
-- Provider payloads remain in monitor_records; this table contains only the
-- compact fields Layne needs to retrieve and reason over.
create table public.monitor_events (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 source_id uuid not null,
 source_kind text not null,
 source_event_id text not null,
 schema_version smallint not null default 1 check (schema_version >= 1),
 event_type text not null,
 title text,
 summary text,
 occurred_at timestamptz,
 detected_at timestamptz not null default now(),
 importance numeric(4,3) not null default 0.5 check (importance >= 0 and importance <= 1),
 confidence numeric(4,3) not null default 0.5 check (confidence >= 0 and confidence <= 1),
 action_required boolean not null default false,
 suggested_actions jsonb not null default '[]'::jsonb check (jsonb_typeof(suggested_actions) = 'array'),
 entities jsonb not null default '[]'::jsonb check (jsonb_typeof(entities) = 'array'),
 domains text[] not null default '{}'::text[],
 tags text[] not null default '{}'::text[],
 status text not null default 'active' check (status in ('active','resolved','deleted')),
 metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
 unique (user_id, source_id, source_event_id),
 foreign key (source_id, user_id) references public.monitor_sources(id, user_id)
);

create index monitor_events_owner_time
 on public.monitor_events(user_id, occurred_at desc);
create index monitor_events_owner_importance
 on public.monitor_events(user_id, importance desc, occurred_at desc)
 where status = 'active';
create index monitor_events_source_type
 on public.monitor_events(user_id, source_kind, event_type, occurred_at desc);
create index monitor_events_action_required
 on public.monitor_events(user_id, action_required, occurred_at desc)
 where status = 'active' and action_required = true;

alter table public.monitor_events enable row level security;
revoke all on public.monitor_events from anon, authenticated;
grant select on public.monitor_events to authenticated;
grant all on public.monitor_events to service_role;
create policy monitor_events_owner_read on public.monitor_events
 for select to authenticated
 using ((select auth.uid()) = user_id);
