-- 013: daily cycle count report: every daily count in a period (or one warehouse), with its SKU/batch results.
-- Used by the Excel export (Daily tab / Dashboard) and the daily sign-off PDF. Admin only, includes RM.
create or replace function public.admin_dcc_report(p_token text, p_from date, p_to date, p_branch text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare res jsonb;
begin
  perform private.need_admin(p_token);
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pick a valid period'; end if;
  if p_to - p_from > 62 then raise exception 'Pick a period of at most 2 months'; end if;
  perform private.roll_daily();
  select jsonb_build_object('from', p_from, 'to', p_to, 'tolerance', private.setting('tolerance'),
           'takes', coalesce(jsonb_agg(x.j order by x.d, x.sort, x.branch), '[]'::jsonb))
    into res
  from (
    select t.count_date as d, b.sort, b.name as branch, jsonb_build_object(
      'id', t.id, 'branch', b.name, 'region', b.region, 'nom', b.nom, 'date', t.count_date, 'takeStatus', t.status,
      'skipReason', t.skip_reason, 'from', to_char(b.count_from, 'HH24:MI'), 'to', to_char(b.count_to, 'HH24:MI'),
      'plan', coalesce(t.plan, '{}'::jsonb), 'listed', coalesce(array_length(t.skus, 1), 0),
      'snapDate', (select snap_date from public.snapshots where id = t.snap_id),
      'startedAt', ss.st0, 'submittedAt', ss.sub,
      'late', case when ss.sub is not null then (ss.sub at time zone 'Asia/Kuala_Lumpur')::date > t.count_date
                                               or (ss.sub at time zone 'Asia/Kuala_Lumpur')::time > b.count_to end,
      'who', (select string_agg(distinct n, ', ') from public.count_sessions s2 cross join lateral private.sess_names(s2.data) n
              where s2.take_id = t.id and private.has_qty(s2.data)),
      'photos', (select count(*) from public.session_photos p join public.count_sessions s3 on s3.id = p.session_id where s3.take_id = t.id),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('code', v.code, 'desc', (select k.descr from public.skus k where k.code = v.code),
                  'batch', v.batch, 'sys', v.sys, 'cost', v.cost, 'phys', v.phys, 'status', v.status, 'v', v.v, 'vv', v.vv,
                  'flag', v.sku_flag, 'pct', v.sku_pct) order by v.code, v.batch), '[]'::jsonb)
                from private.variance(t.id) v where v.branch = b.name)
    ) as j
    from public.stock_takes t join public.branches b on b.name = t.branch
    cross join lateral (select min(s.started_at) filter (where private.has_qty(s.data)) as st0,
                               min(s.submitted_at) filter (where s.status = 'submitted') as sub
                        from public.count_sessions s where s.take_id = t.id) ss
    where t.kind = 'daily' and t.count_date between p_from and p_to and (p_branch is null or t.branch = p_branch)
  ) x;
  return res;
end $$;

revoke all on function public.admin_dcc_report(text, date, date, text) from public;
grant execute on function public.admin_dcc_report(text, date, date, text) to anon, authenticated;
