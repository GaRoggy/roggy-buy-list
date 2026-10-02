-- Purchase email matching is additive. Gmail message IDs identify email rows;
-- product rows and relationship rows make order lines independently matchable.
-- No email body or credential is stored here.

alter table public.list_items add column if not exists bought_at timestamptz;
alter table public.list_items drop constraint if exists list_items_status_check;
update public.list_items
   set status = 'bought'
 where lower(trim(status)) = 'bought' and status <> 'bought';
alter table public.list_items add constraint list_items_status_check
  check (status in ('looking','ready_to_buy','bought','Looking','Ready to Buy','Bought'));
update public.list_items
   set bought_at = coalesce(bought_at, deleted_at, updated_at, created_at)
 where status = 'bought' and bought_at is null;
create index if not exists list_items_bought_candidates
  on public.list_items(user_id, list_type, status, bought_at desc, updated_at desc)
  where list_type = 'buy' and status = 'bought';

create table if not exists public.purchase_emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  source_id uuid not null,
  monitor_record_id uuid references public.monitor_records(id) on delete set null,
  gmail_message_id text not null,
  thread_id text,
  sender text,
  subject text,
  received_at timestamptz,
  merchant text,
  order_number text,
  email_type text check (email_type in (
    'order_confirmation','receipt','shipping_confirmation','out_for_delivery',
    'delivered','pickup_ready','delayed','backordered','cancelled','refund',
    'return_started','returned','payment_confirmation'
  )),
  order_total numeric,
  order_currency text,
  purchase_date timestamptz,
  estimated_delivery_date timestamptz,
  tracking_number text,
  carrier text,
  order_status text,
  metadata jsonb not null default '{}'::jsonb,
  extraction_version text not null default 'purchase-matching-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (source_id, user_id) references public.monitor_sources(id, user_id),
  unique (user_id, gmail_message_id)
);
create index if not exists purchase_emails_owner_received
  on public.purchase_emails(user_id, received_at desc);
create index if not exists purchase_emails_owner_order
  on public.purchase_emails(user_id, order_number)
  where order_number is not null;
create index if not exists purchase_emails_owner_thread
  on public.purchase_emails(user_id, thread_id)
  where thread_id is not null;
create index if not exists purchase_emails_owner_tracking
  on public.purchase_emails(user_id, tracking_number)
  where tracking_number is not null;

create table if not exists public.purchase_email_products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  email_id uuid not null references public.purchase_emails(id) on delete cascade,
  product_fingerprint text not null,
  line_index integer not null default 0 check (line_index >= 0),
  product_name text not null,
  normalized_product_name text not null,
  model_number text,
  sku text,
  quantity numeric,
  price numeric,
  currency text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email_id, product_fingerprint)
);
create index if not exists purchase_email_products_owner_name
  on public.purchase_email_products(user_id, normalized_product_name);
create index if not exists purchase_email_products_email
  on public.purchase_email_products(email_id, line_index);

create table if not exists public.purchase_email_matches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  buy_item_id uuid references public.list_items(id) on delete set null,
  email_id uuid not null references public.purchase_emails(id) on delete cascade,
  email_product_id uuid references public.purchase_email_products(id) on delete set null,
  buy_item_label text,
  buy_item_status_at_match text,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  match_status text not null check (match_status in ('auto','suggested','confirmed','rejected')),
  match_reason jsonb not null default '{}'::jsonb,
  latest_lifecycle_status text,
  latest_lifecycle_at timestamptz,
  matched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- NULL product IDs are allowed for order-level/lifecycle matches. Coalesce only
-- for the duplicate key so the same relationship remains idempotent.
create unique index if not exists purchase_email_matches_relationship
  on public.purchase_email_matches(
    buy_item_id, email_id, coalesce(email_product_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
create index if not exists purchase_email_matches_owner_item
  on public.purchase_email_matches(user_id, buy_item_id, updated_at desc);
create index if not exists purchase_email_matches_owner_email
  on public.purchase_email_matches(user_id, email_id, updated_at desc);
create index if not exists purchase_email_matches_suggestions
  on public.purchase_email_matches(user_id, match_status, confidence desc)
  where match_status = 'suggested';

create table if not exists public.purchase_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  buy_item_id uuid references public.list_items(id) on delete set null,
  email_id uuid not null references public.purchase_emails(id) on delete cascade,
  email_product_id uuid references public.purchase_email_products(id) on delete set null,
  event_type text not null check (event_type in (
    'bought','order_confirmed','shipped','out_for_delivery','delivered',
    'delayed','backordered','cancelled','refund_pending','refunded',
    'return_started','returned','payment_confirmation'
  )),
  event_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  event_key text generated always as (
    email_id::text || ':' || coalesce(buy_item_id::text, 'order') || ':' ||
    coalesce(email_product_id::text, 'email') || ':' || event_type
  ) stored,
  created_at timestamptz not null default now(),
  unique (event_key)
);
create index if not exists purchase_lifecycle_owner_item
  on public.purchase_lifecycle_events(user_id, buy_item_id, event_at desc);
create index if not exists purchase_lifecycle_owner_email
  on public.purchase_lifecycle_events(user_id, email_id, event_at desc);

do $$ declare table_name text; begin
  foreach table_name in array array['purchase_emails','purchase_email_products','purchase_email_matches','purchase_lifecycle_events'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
    execute format('create policy purchase_owner_read on public.%I for select to authenticated using ((select auth.uid()) = user_id)', table_name);
  end loop;
end $$;

create or replace function public.monitor_process_purchase_email(
  p_user_id uuid,
  p_source_id uuid,
  p_monitor_record_id uuid,
  p_email jsonb,
  p_products jsonb default '[]'::jsonb,
  p_matches jsonb default '[]'::jsonb,
  p_lifecycle jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  email_row public.purchase_emails%rowtype;
  product_row jsonb;
  match_row jsonb;
  lifecycle_row jsonb;
  product_id uuid;
  match_item uuid;
  match_email_product uuid;
  item_label text;
  item_status text;
  item_received timestamptz;
  email_type text;
  match_count integer := 0;
  suggestion_count integer := 0;
  lifecycle_count integer := 0;
begin
  if coalesce((p_email->>'purchase_related')::boolean, false) = false then
    return jsonb_build_object('ignored', true, 'reason', 'not_purchase_related');
  end if;

  insert into public.purchase_emails(
    user_id, source_id, monitor_record_id, gmail_message_id, thread_id, sender,
    subject, received_at, merchant, order_number, email_type, order_total,
    order_currency, purchase_date, estimated_delivery_date, tracking_number,
    carrier, order_status, metadata, extraction_version, updated_at
  ) values (
    p_user_id, p_source_id, p_monitor_record_id,
    left(coalesce(p_email->>'source_message_id', ''), 200),
    nullif(left(p_email->>'thread_id', 200), ''), nullif(left(p_email->>'sender', 500), ''),
    nullif(left(p_email->>'subject', 1000), ''),
    public.monitor_safe_timestamptz(p_email->>'timestamp'),
    nullif(left(p_email->'purchase'->>'merchant', 200), ''),
    nullif(left(p_email->'purchase'->>'order_number', 120), ''),
    nullif(p_email->'purchase'->>'email_type', ''),
    case when p_email->'purchase'->'order_total'->>'amount' ~ '^\d+(\.\d+)?$' then (p_email->'purchase'->'order_total'->>'amount')::numeric else null end,
    nullif(left(p_email->'purchase'->'order_total'->>'currency', 8), ''),
    public.monitor_safe_timestamptz(p_email->'purchase'->>'purchase_date'),
    public.monitor_safe_timestamptz(p_email->'purchase'->>'estimated_delivery_date'),
    nullif(left(p_email->'purchase'->>'tracking_number', 120), ''),
    nullif(left(p_email->'purchase'->>'carrier', 120), ''),
    nullif(left(p_email->'purchase'->>'order_status', 60), ''),
    jsonb_build_object('category', p_email->>'category', 'labels', coalesce(p_email->'labels','[]'::jsonb), 'extraction_notes', p_email->>'extraction_notes'),
    coalesce(nullif(p_email->'purchase'->>'extraction_version',''), 'purchase-matching-v1'), now()
  )
  on conflict (user_id, gmail_message_id) do update set
    source_id = excluded.source_id, monitor_record_id = excluded.monitor_record_id,
    thread_id = excluded.thread_id, sender = excluded.sender, subject = excluded.subject,
    received_at = excluded.received_at, merchant = excluded.merchant,
    order_number = excluded.order_number, email_type = excluded.email_type,
    order_total = excluded.order_total, order_currency = excluded.order_currency,
    purchase_date = excluded.purchase_date, estimated_delivery_date = excluded.estimated_delivery_date,
    tracking_number = excluded.tracking_number, carrier = excluded.carrier,
    order_status = excluded.order_status, metadata = excluded.metadata,
    extraction_version = excluded.extraction_version, updated_at = now()
  returning * into email_row;

  for product_row in select value from jsonb_array_elements(coalesce(p_products, '[]'::jsonb)) loop
    insert into public.purchase_email_products(
      user_id, email_id, product_fingerprint, line_index, product_name,
      normalized_product_name, model_number, sku, quantity, price, currency, metadata, updated_at
    ) values (
      p_user_id, email_row.id,
      left(coalesce(product_row->>'product_fingerprint', md5(coalesce(product_row->>'product_name','') || ':' || coalesce(product_row->>'line_index','0'))), 80),
      greatest(0, coalesce((product_row->>'line_index')::integer, 0)),
      left(coalesce(product_row->>'product_name', '(Unspecified product)'), 300),
      left(coalesce(product_row->>'normalized_product_name', lower(product_row->>'product_name')), 300),
      nullif(left(product_row->>'model_number', 100), ''), nullif(left(product_row->>'sku', 100), ''),
      case when product_row->>'quantity' ~ '^\d+(\.\d+)?$' then (product_row->>'quantity')::numeric else null end,
      case when product_row->>'price' ~ '^\d+(\.\d+)?$' then (product_row->>'price')::numeric else null end,
      nullif(left(product_row->>'currency', 8), ''), coalesce(product_row->'metadata','{}'::jsonb), now()
    ) on conflict (email_id, product_fingerprint) do update set
      line_index = excluded.line_index, product_name = excluded.product_name,
      normalized_product_name = excluded.normalized_product_name, model_number = excluded.model_number,
      sku = excluded.sku, quantity = excluded.quantity, price = excluded.price,
      currency = excluded.currency, metadata = excluded.metadata, updated_at = now();
  end loop;

  for match_row in select value from jsonb_array_elements(coalesce(p_matches, '[]'::jsonb)) loop
    begin
      match_item := (match_row->>'buy_item_id')::uuid;
    exception when others then match_item := null;
    end;
    if match_item is null then continue; end if;
    select item, status into item_label, item_status
      from public.list_items where id = match_item and user_id = p_user_id and list_type = 'buy';
    if not found then continue; end if;
    select id into match_email_product
      from public.purchase_email_products
     where email_id = email_row.id and product_fingerprint = nullif(match_row->>'product_fingerprint','')
     limit 1;
    insert into public.purchase_email_matches(
      user_id, buy_item_id, email_id, email_product_id, buy_item_label,
      buy_item_status_at_match, confidence, match_status, match_reason, matched_at, updated_at
    ) values (
      p_user_id, match_item, email_row.id, match_email_product, item_label, item_status,
      greatest(0, least(1, coalesce((match_row->>'confidence')::numeric, 0))),
      case when match_row->>'match_status' in ('auto','suggested','confirmed','rejected') then match_row->>'match_status' else 'suggested' end,
      coalesce(match_row->'match_reason','{}'::jsonb), now(), now()
    ) on conflict do nothing;
    update public.purchase_email_matches
       set confidence = greatest(confidence, greatest(0, least(1, coalesce((match_row->>'confidence')::numeric, 0)))),
           match_reason = case when match_status in ('confirmed','rejected') then match_reason else coalesce(match_row->'match_reason','{}'::jsonb) end,
           match_status = case when match_status in ('confirmed','rejected') then match_status
                               when match_row->>'match_status' = 'auto' then 'auto' else match_status end,
           updated_at = now()
     where user_id = p_user_id and email_id = email_row.id
       and buy_item_id is not distinct from match_item
       and email_product_id is not distinct from match_email_product;
    if match_row->>'match_status' = 'auto' then
      update public.list_items set status = 'bought', bought_at = coalesce(bought_at, email_row.received_at, now()), updated_at = now()
       where id = match_item and user_id = p_user_id and list_type = 'buy';
      match_count := match_count + 1;
    elsif match_row->>'match_status' = 'suggested' then
      suggestion_count := suggestion_count + 1;
    end if;
  end loop;

  for lifecycle_row in select value from jsonb_array_elements(coalesce(p_lifecycle, '[]'::jsonb)) loop
    begin
      match_item := nullif(lifecycle_row->>'buy_item_id','')::uuid;
    exception when others then match_item := null;
    end;
    select id into match_email_product from public.purchase_email_products
     where email_id = email_row.id and product_fingerprint = nullif(lifecycle_row->>'product_fingerprint','') limit 1;
    insert into public.purchase_lifecycle_events(user_id,buy_item_id,email_id,email_product_id,event_type,event_at,details)
    values(p_user_id,match_item,email_row.id,match_email_product,
      nullif(lifecycle_row->>'event_type',''),
      public.monitor_safe_timestamptz(lifecycle_row->>'event_at'),
      coalesce(lifecycle_row->'details','{}'::jsonb))
    on conflict(event_key) do nothing;
    update public.purchase_email_matches set latest_lifecycle_status = lifecycle_row->>'event_type',
      latest_lifecycle_at = public.monitor_safe_timestamptz(lifecycle_row->>'event_at'), updated_at = now()
     where user_id = p_user_id and email_id = email_row.id
       and buy_item_id is not distinct from match_item
       and email_product_id is not distinct from match_email_product
       and (latest_lifecycle_at is null or latest_lifecycle_at <= public.monitor_safe_timestamptz(lifecycle_row->>'event_at'));
    lifecycle_count := lifecycle_count + 1;
  end loop;

  return jsonb_build_object('ignored', false, 'email_id', email_row.id,
    'matches_created', match_count, 'suggestions_created', suggestion_count,
    'lifecycle_events', lifecycle_count);
end $$;

revoke all on function public.monitor_process_purchase_email(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.monitor_process_purchase_email(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb) to service_role;

create or replace function public.monitor_purchase_related_items(
  p_user_id uuid,
  p_order_number text default null,
  p_thread_id text default null,
  p_tracking_number text default null
) returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_data), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'buy_item_id', m.buy_item_id,
      'confidence', max(m.confidence),
      'evidence', jsonb_build_array('existing order/thread/tracking relationship')
    ) as row_data
    from public.purchase_email_matches m
    join public.purchase_emails e on e.id = m.email_id and e.user_id = m.user_id
    where m.user_id = p_user_id and m.buy_item_id is not null
      and (
        (nullif(p_order_number, '') is not null and e.order_number = p_order_number)
        or (nullif(p_thread_id, '') is not null and e.thread_id = p_thread_id)
        or (nullif(p_tracking_number, '') is not null and e.tracking_number = p_tracking_number)
      )
    group by m.buy_item_id
  ) grouped;
$$;

revoke all on function public.monitor_purchase_related_items(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.monitor_purchase_related_items(uuid,text,text,text) to service_role;
