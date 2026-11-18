-- 010: daily takes carry their warehouse's count window end, so the counter screen can say
-- "finish by 10:00". Adds one field; every existing caller keeps working.
create or replace function private.take_json(t public.stock_takes)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'status', t.status, 'closed', t.status = 'closed',
    'scope', t.scope, 'mode', t.mode, 'skuCount', coalesce(array_length(t.skus, 1), 0), 'resetId', t.reset_id,
    'startedAt', t.started_at, 'openedAt', t.opened_at, 'closedAt', t.closed_at,
    'kind', t.kind, 'branch', t.branch, 'countDate', t.count_date, 'skipReason', t.skip_reason,
    'countTo', case when t.kind = 'daily' then (select to_char(b.count_to, 'HH24:MI') from public.branches b where b.name = t.branch) end)
$$;
