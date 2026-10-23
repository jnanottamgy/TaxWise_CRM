-- 0108 · Profile self-service (§7.1): your name and phone live on your profile and on your staff
-- record. Employees can't update employees rows through the API (0032), so this function updates
-- both, for the signed-in person only.
--
-- Concurrency (§13) is checked on the two fields themselves, not on profiles.updated_at: theme,
-- density, favourites and the financial year also write the profile (preferences), and those must
-- not make a name change look like a conflict. The caller passes the values it showed; if either
-- changed since (a Partner edited the record, or another tab saved), nothing is written.

set search_path = public, extensions;

create or replace function public.update_my_contact(p_full_name text, p_phone text, p_was_full_name text, p_was_phone text)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_updated timestamptz;
begin
  if v_uid is null or not public.is_staff() then
    raise exception 'USER: Only the firm''s staff update their details here.' using errcode = 'P0001';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'USER: Enter your full name.' using errcode = 'P0001';
  end if;
  if v_phone is not null and (length(v_phone) > 30 or v_phone !~ '^[0-9+\-\s()]+$') then
    raise exception 'USER: Use digits only for the phone number, with spaces or a + if you like.' using errcode = 'P0001';
  end if;

  select * into v_profile from public.profiles p where p.id = v_uid for update;
  if not found then
    raise exception 'USER: Your profile is missing. Ask a Partner.' using errcode = 'P0001';
  end if;
  if v_profile.full_name is distinct from btrim(coalesce(p_was_full_name, ''))
     or coalesce(v_profile.phone, '') <> btrim(coalesce(p_was_phone, '')) then
    raise exception 'USER: Your name or phone was changed at %, after you opened this page (by a Partner, or in another tab). Reload to see the changes.',
      to_char(v_profile.updated_at at time zone 'Asia/Kolkata', 'HH24:MI') using errcode = 'P0001';
  end if;

  if v_profile.full_name = v_name and v_profile.phone is not distinct from v_phone then
    return v_profile.updated_at;
  end if;
  update public.profiles set full_name = v_name, phone = v_phone where id = v_uid returning updated_at into v_updated;
  update public.employees set full_name = v_name, phone = v_phone where profile_id = v_uid and deleted_at is null;
  return v_updated;
end;
$$;

comment on function public.update_my_contact(text, text, text, text) is
  '§7.1 Profile: the signed-in staff member''s name and phone, on the profile and the staff record together; refuses if either changed since the caller read them.';

revoke execute on function public.update_my_contact(text, text, text, text) from public, anon;
grant execute on function public.update_my_contact(text, text, text, text) to authenticated, service_role;
