-- 024: the app is now called My Warehouse (title kept if an admin had set their own)
update public.settings set value = '"My Warehouse"' where key = 'title' and value #>> '{}' in ('NDD Stock Count', '');
