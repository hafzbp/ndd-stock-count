-- Run in Supabase SQL editor: branches created via Setup → Edit branch list also get an automatic PIN.
create or replace function public.admin_save_team(p_token text, p_branches text[], p_team jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare b text; ord int := 0;
begin
  perform private.need_admin(p_token);
  foreach b in array p_branches loop
    ord := ord + 1;
    if trim(b) = '' then continue; end if;
    insert into public.branches (name, active, sort, pin) values (trim(b), true, ord, private.new_pin())
    on conflict (name) do update set active = true, sort = excluded.sort;
  end loop;
  update public.branches set active = false where name <> all (p_branches);
  delete from public.team where true;
  insert into public.team (name, branch, role)
  select t ->> 'name', t ->> 'branch', case when t ->> 'role' = 'Counter' then 'Counter' else 'Checker' end
  from jsonb_array_elements(coalesce(p_team, '[]'::jsonb)) t
  where coalesce(t ->> 'name', '') <> '' and t ->> 'branch' = any (p_branches);
end $$;

