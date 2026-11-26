-- 019: import a result Excel from the previous (artifact) app as a CLOSED monthly stock take.
-- The browser reads the Excel (sheets Counts, Variance, Summary) and sends p_payload:
--   {name, opened, closed, loaded, source, meta{goodV,blockedV,badLocV,transitV,skippedV,imported:true,source},
--    skus[{code,desc,per,box}], sys[{b,c,bt,q,u}], sessions[{branch,member,device,start,end,lines{key:{code,batch,ctn,box,pcs,per,perBox,total,remark,t}}}]}
-- Creates the stock take (closed, total, single count, good stock, no KPI month), its system stock, MB52 tie-out and one
-- submitted Ops count per warehouse + person. Warehouses not in the app are skipped. Only unknown SKUs are added.
-- Cartons/boxes are kept only when the app's pack size equals the file's; otherwise the line's total pieces are stored.
create or replace function public.admin_import_take(p_token text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p jsonb := p_payload; tk uuid; s jsonb; skipped text[];
begin
  perform private.need_admin(p_token);
  if jsonb_array_length(coalesce(p -> 'sessions', '[]')) = 0 or jsonb_array_length(coalesce(p -> 'sys', '[]')) = 0 then raise exception 'Nothing to import: no counts or no system stock in the file.'; end if;
  if exists (select 1 from public.stock_takes where name = p ->> 'name') then raise exception 'Already imported: %', p ->> 'name'; end if;
  insert into public.skus (code, descr, per, per_box)
    select x ->> 'code', x ->> 'desc', (x ->> 'per')::numeric, (x ->> 'box')::numeric from jsonb_array_elements(p -> 'skus') x
    on conflict (code) do nothing;
  insert into public.stock_takes (name, started_at, closed, status, scope, mode, kind, stock_type, opened_at, closed_at)
    values (p ->> 'name', (p ->> 'opened')::timestamptz, true, 'closed', 'total', 'single', 'monthly', 'good', (p ->> 'opened')::timestamptz, (p ->> 'closed')::timestamptz)
    returning id into tk;
  insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost)
    select tk, x ->> 'b', x ->> 'c', x ->> 'bt', (x ->> 'q')::numeric, (x ->> 'u')::numeric
    from jsonb_array_elements(p -> 'sys') x where exists (select 1 from public.branches br where br.name = x ->> 'b');
  insert into public.mb52_meta (take_id, data, loaded_at) values (tk, p -> 'meta', (p ->> 'loaded')::timestamptz);
  for s in select * from jsonb_array_elements(p -> 'sessions') loop
    if not exists (select 1 from public.branches br where br.name = s ->> 'branch') then skipped := array_append(skipped, s ->> 'branch'); continue; end if;
    insert into public.count_sessions (take_id, device_id, branch, role, data, status, started_at, updated_at, submitted_at)
    values (tk, s ->> 'device', s ->> 'branch', 'ops',
      jsonb_build_object('member', s ->> 'member', 'names', jsonb_build_array(s ->> 'member'), 'imported', true, 'lines',
        (select coalesce(jsonb_object_agg(e.key,
           case when coalesce((e.value ->> 'ctn')::numeric, 0) = 0 and coalesce((e.value ->> 'box')::numeric, 0) = 0
                  or (((sk.per = (e.value ->> 'per')::numeric) or coalesce((e.value ->> 'ctn')::numeric, 0) = 0)
                      and ((sk.per_box = (e.value ->> 'perBox')::numeric) or coalesce((e.value ->> 'box')::numeric, 0) = 0))
                then jsonb_build_object('code', e.value ->> 'code', 'batch', e.value ->> 'batch', 'ctn', e.value -> 'ctn', 'box', e.value -> 'box', 'pcs', e.value -> 'pcs', 'remark', e.value ->> 'remark', 't', e.value ->> 't')
                else jsonb_build_object('code', e.value ->> 'code', 'batch', e.value ->> 'batch', 'ctn', null, 'box', null, 'pcs', e.value -> 'total',
                       'remark', trim(coalesce(e.value ->> 'remark', '') || ' [keyed ' || coalesce(e.value ->> 'ctn', '0') || ' ctn ' || coalesce(e.value ->> 'box', '0') || ' box ' || coalesce(e.value ->> 'pcs', '0') || ' pcs]'), 't', e.value ->> 't') end), '{}'::jsonb)
         from jsonb_each(s -> 'lines') e left join public.skus sk on sk.code = e.value ->> 'code')),
      'submitted', (s ->> 'start')::timestamptz, (s ->> 'end')::timestamptz, (s ->> 'end')::timestamptz);
  end loop;
  return jsonb_build_object('ok', true, 'take', tk, 'skipped', to_jsonb(coalesce(skipped, '{}'::text[])));
end $$;
revoke all on function public.admin_import_take(text, jsonb) from public;
grant execute on function public.admin_import_take(text, jsonb) to anon, authenticated;
