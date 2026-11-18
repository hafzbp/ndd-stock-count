-- 012: uploading the daily MB52 again on the same day emptied this month's ABC (it was deleted to be redone, but only
-- rebuilt when the next daily list is planned). Now it is rebuilt during the upload.
create or replace function public.admin_load_daily(p_token text, p_date date, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare sid uuid; b text; pl jsonb; n int := 0; t public.stock_takes;
begin
  perform private.need_admin(p_token);
  if p_date is null or p_date > private.today() then raise exception 'Pick the stock date (today or earlier)'; end if;
  insert into public.snapshots (snap_date, meta) values (p_date, coalesce(p_payload -> 'meta', '{}'::jsonb))
    on conflict (snap_date) do update set meta = excluded.meta, loaded_at = now()
    returning id into sid;
  delete from public.snap_stock where snap_id = sid;
  for b in select jsonb_object_keys(p_payload -> 'byBr') loop
    insert into public.snap_stock (snap_id, branch, code, batch, qty, unit_cost, sloc)
    select sid, b, r ->> 0, coalesce(r ->> 1, ''), (r ->> 2)::numeric, nullif(r ->> 3, '')::numeric, r ->> 4
    from jsonb_array_elements(p_payload -> 'byBr' -> b) r;
    n := n + 1;
  end loop;
  for b, pl in select key, value from jsonb_each(coalesce(p_payload -> 'plants', '{}'::jsonb)) loop
    update public.branches set plants = array(select distinct x from unnest(plants || array(select jsonb_array_elements_text(pl))) x where x <> '')
      where name = b;
  end loop;
  insert into public.skus (code, descr)
  select d.key, d.value #>> '{}' from jsonb_each(coalesce(p_payload -> 'descs', '{}'::jsonb)) d
  on conflict (code) do update set descr = case when public.skus.descr = '' then excluded.descr else public.skus.descr end;
  insert into public.skus (code, descr) select distinct code, '' from public.snap_stock where snap_id = sid on conflict (code) do nothing;
  -- ABC of this month is redone from the newest upload until the warehouse's first count of the month is logged
  -- (so a wrong first file doesn't fix the classes for the whole month)
  delete from public.sku_class sc where sc.month = date_trunc('month', p_date)::date and not sc.override
    and sc.branch in (select jsonb_object_keys(p_payload -> 'byBr'))
    and not exists (select 1 from public.count_log l where l.branch = sc.branch and l.count_date >= date_trunc('month', p_date)::date);
  -- ...and rebuilt right away from this upload. Before 012 it was only rebuilt when the next daily list was planned,
  -- so a second upload on the same day left the ABC, the supervisor's plan and the dashboard empty until tomorrow.
  perform private.ensure_abc(x, date_trunc('month', p_date)::date, sid) from jsonb_object_keys(p_payload -> 'byBr') x;
  -- refresh open daily counts that use an older or the same upload
  for t in select x.* from public.stock_takes x join public.snapshots s on s.id = x.snap_id
           where x.kind = 'daily' and x.status = 'open' and x.count_date >= p_date and s.snap_date <= p_date loop
    delete from public.sys_stock where take_id = t.id;
    insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost, sloc)
    select t.id, s.branch, s.code, s.batch, s.qty, s.unit_cost, s.sloc
    from public.snap_stock s where s.snap_id = sid and s.branch = t.branch and s.stype = 'good' and s.code = any (t.skus);
    update public.stock_takes set snap_id = sid where id = t.id;
  end loop;
  delete from public.snapshots where id in (select id from public.snapshots order by snap_date desc offset 14)
    and id not in (select snap_id from public.stock_takes where snap_id is not null and status = 'open');
  return jsonb_build_object('branches', n, 'date', p_date);
end $$;
