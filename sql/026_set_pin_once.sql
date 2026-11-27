-- 026: choosing a PIN twice in a row (a double tap sends it twice) is fine; only the temporary PIN can't be kept.
create or replace function public.person_set_pin(p_token text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.people := private.need_person(p_token);
begin
  if not private.pin_ok(coalesce(p_pin, ''), 6) then
    raise exception 'Use 6 digits, not all the same and not in a row like 123456';
  end if;
  if p.pin_hash is not null and p.pin_hash = extensions.crypt(p_pin, p.pin_hash) then
    if p.must_change then raise exception 'Choose a new PIN, not the temporary one'; end if;
    return jsonb_build_object('ok', true);
  end if;
  update public.people set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')), must_change = false where id = p.id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.person_set_pin(text, text) from public;
grant execute on function public.person_set_pin(text, text) to anon, authenticated;
