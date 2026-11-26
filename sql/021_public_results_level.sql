-- 021: public results show RM when Finance publishes values (Setup → Public dashboard = value), no password.
--      An admin login on the same device (p_token) also sees RM. p_password is kept in the signature but no longer used.
create or replace function public.public_results(p_take uuid, p_password text default null, p_token text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d jsonb; ok boolean; lvl text := coalesce(private.setting('dash_level') #>> '{}', 'progress');
begin
  select r.data into d from public.take_results r join public.stock_takes t on t.id = r.take_id
   where r.take_id = p_take and t.status = 'closed';
  if d is null then raise exception 'These results are not available.'; end if;
  ok := lvl = 'value' or (p_token is not null and private.tok_kind(p_token) in ('owner', 'finance'));
  if not ok then
    d := d - 'rm';
    d := jsonb_set(d, '{wh}', coalesce((select jsonb_agg(e - 'rm' order by o) from jsonb_array_elements(d -> 'wh') with ordinality x(e, o)), '[]'::jsonb));
  end if;
  return d || jsonb_build_object('withRM', ok, 'level', lvl, 'savedAt', (select saved_at from public.take_results where take_id = p_take));
end $$;
revoke all on function public.public_results(uuid, text, text) from public;
grant execute on function public.public_results(uuid, text, text) to anon, authenticated;
