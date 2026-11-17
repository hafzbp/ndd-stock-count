-- New branches get a random 4-digit PIN automatically (unique among branches).
create or replace function private.new_pin()
returns text language plpgsql volatile set search_path = '' as $$
declare p text;
begin
  loop
    p := (1000 + floor(random() * 9000))::int::text;
    exit when not exists (select 1 from public.branches where pin = p);
  end loop;
  return p;
end $$;
revoke execute on function private.new_pin() from public, anon, authenticated;

-- Add branches without touching the team (used when MB52 has new branch names).
create or replace function public.admin_add_branches(p_token text, p_branches text[])
returns int language plpgsql volatile security definer set search_path = '' as $$
declare b text; n int := 0; mx int;
begin
  perform private.need_admin(p_token);
  select coalesce(max(sort), 0) into mx from public.branches;
  foreach b in array p_branches loop
    if trim(b) = '' then continue; end if;
    if exists (select 1 from public.branches where name = trim(b)) then
      update public.branches set active = true where name = trim(b);
    else
      mx := mx + 1; n := n + 1;
      insert into public.branches (name, active, sort, pin) values (trim(b), true, mx, private.new_pin());
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.admin_add_branches(text, text[]) from public;
grant execute on function public.admin_add_branches(text, text[]) to anon, authenticated;
