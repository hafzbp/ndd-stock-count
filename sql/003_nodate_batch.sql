-- Show a "No date" batch row to counters when SAP has stock without a batch for that SKU.
create or replace function public.counter_branch(p_token text, p_branch text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare tk uuid := private.cur_take();
begin
  perform private.need_branch(p_token, p_branch);
  return jsonb_build_object(
    'branch', p_branch,
    'codes', coalesce((select jsonb_agg(distinct code) from public.sys_stock where take_id = tk and branch = p_branch), '[]'::jsonb),
    'batches', coalesce((select jsonb_object_agg(code, bs) from (
        select code, jsonb_agg(distinct private.month_of(batch)) as bs
        from public.sys_stock where take_id = tk and branch = p_branch group by code) x), '{}'::jsonb),
    'recount', coalesce((select to_jsonb(items) from public.recount where take_id = tk and branch = p_branch), '[]'::jsonb));
end $$;
