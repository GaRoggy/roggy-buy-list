-- Keep normal fuzzy matching bounded to recent Bought items. Older items that
-- have not received a confident relationship remain eligible for remediation.

create or replace function public.monitor_purchase_unresolved_candidates(
  p_user_id uuid,
  p_cutoff timestamptz
) returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(rows)), '[]'::jsonb)
  from (
    select li.id, li.item, li.category, li.quantity, li.status, li.bought_at,
      li.deleted_at, li.created_at, li.updated_at, li.target_price
    from public.list_items li
    where li.user_id = p_user_id and li.list_type = 'buy' and li.status = 'bought'
      and (li.bought_at is null or li.bought_at < p_cutoff)
      and not exists (
        select 1 from public.purchase_email_matches m
        where m.user_id = p_user_id and m.buy_item_id = li.id
          and m.match_status in ('auto','confirmed')
      )
    order by li.bought_at desc nulls last, li.updated_at desc
    limit 200
  ) rows;
$$;
revoke all on function public.monitor_purchase_unresolved_candidates(uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.monitor_purchase_unresolved_candidates(uuid,timestamptz) to service_role;

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
      'item', li.item,
      'category', li.category,
      'quantity', li.quantity,
      'status', li.status,
      'bought_at', li.bought_at,
      'updated_at', li.updated_at,
      'confidence', max(m.confidence),
      'evidence', jsonb_build_array('existing order/thread/tracking relationship')
    ) as row_data
    from public.purchase_email_matches m
    join public.purchase_emails e on e.id = m.email_id and e.user_id = m.user_id
    join public.list_items li on li.id = m.buy_item_id and li.user_id = m.user_id
    where m.user_id = p_user_id and m.buy_item_id is not null
      and (
        (nullif(p_order_number, '') is not null and e.order_number = p_order_number)
        or (nullif(p_thread_id, '') is not null and e.thread_id = p_thread_id)
        or (nullif(p_tracking_number, '') is not null and e.tracking_number = p_tracking_number)
      )
    group by m.buy_item_id, li.item, li.category, li.quantity, li.status, li.bought_at, li.updated_at
  ) grouped;
$$;
revoke all on function public.monitor_purchase_related_items(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.monitor_purchase_related_items(uuid,text,text,text) to service_role;

