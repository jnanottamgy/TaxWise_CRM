-- 0107 · Cover access: merging and the lifecycle markers (§4.7, §5.13, §8 "Cover lifecycle").
--
--   client_covers.ending_notified_at   the hourly job sends "Cover ends tomorrow" to the granter
--                                      once; this records that it went.
--   client_covers.merged_into          a cover absorbed by a merge points at the cover that
--                                      replaced it (revoked with "Merged into a longer cover").
--   client_covers_merge                BEFORE INSERT, every writer: overlapping covers for the same
--                                      client (or the same absent person) and the same cover person
--                                      merge into one, and the later end wins (§4.7 limits). The
--                                      new row widens to the merged window; the covers it absorbs
--                                      are revoked and point at it. A merge that would run past
--                                      90 days is refused. Same rules as planCoverGrant in
--                                      lib/domain/cover.ts.
--
-- The trigger is named so it runs after client_covers_guard (triggers fire in name order): the
-- guard checks the caller's own values (Include portal passwords is Partner only) before the merge
-- carries forward what the absorbed covers already had.

set search_path = public, extensions;

alter table public.client_covers
  add column ending_notified_at timestamptz,
  add column merged_into uuid references public.client_covers (id) deferrable initially deferred;

comment on column public.client_covers.ending_notified_at is 'When the hourly job sent "Cover ends tomorrow" to the granter (§8), so it goes once.';
comment on column public.client_covers.merged_into is 'The cover that absorbed this one in a merge (§4.7: overlapping covers merge, the later end wins).';

create index client_covers_live_idx on public.client_covers (ends_at) where revoked_at is null;
create index client_covers_leave_idx on public.client_covers (leave_id) where leave_id is not null;

create or replace function public.client_covers_merge()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_start timestamptz := new.starts_at;
  v_end timestamptz := new.ends_at;
  v_absorbed uuid[] := '{}';
  v_found uuid[];
  v_handover text;
  v_note text;
  v_vault boolean;
  v_leave uuid;
begin
  loop
    select coalesce(array_agg(c.id), '{}'),
           least(v_start, min(c.starts_at)),
           greatest(v_end, max(c.ends_at))
      into v_found, v_start, v_end
    from public.client_covers c
    where c.revoked_at is null
      and c.id <> all (v_absorbed)
      and c.kind = new.kind
      and c.cover_employee_id = new.cover_employee_id
      and ((new.kind = 'client' and c.client_id = new.client_id)
        or (new.kind = 'person' and c.absent_employee_id = new.absent_employee_id))
      and c.starts_at < v_end
      and v_start < c.ends_at;
    -- min()/max() over no rows are null: keep the window as it was.
    v_start := coalesce(v_start, new.starts_at);
    v_end := coalesce(v_end, new.ends_at);
    exit when cardinality(v_found) = 0;
    v_absorbed := v_absorbed || v_found;
  end loop;

  if cardinality(v_absorbed) = 0 then
    return new;
  end if;

  if v_end > v_start + interval '90 days' then
    raise exception 'USER: This overlaps an existing cover for the same person, and together they would run past 90 days. Shorten it or end the existing cover first.'
      using errcode = 'P0001';
  end if;

  -- Carry forward what the absorbed covers held, newest first, where the new cover leaves it empty.
  select (array_agg(c.handover_note order by c.created_at desc) filter (where nullif(btrim(c.handover_note), '') is not null))[1],
         (array_agg(c.note order by c.created_at desc) filter (where nullif(btrim(c.note), '') is not null))[1],
         bool_or(c.include_vault),
         (array_agg(c.leave_id order by c.created_at desc) filter (where c.leave_id is not null))[1]
    into v_handover, v_note, v_vault, v_leave
  from public.client_covers c where c.id = any (v_absorbed);

  new.starts_at := v_start;
  new.ends_at := v_end;
  new.handover_note := coalesce(nullif(btrim(new.handover_note), ''), v_handover);
  new.note := coalesce(nullif(btrim(new.note), ''), v_note);
  new.include_vault := new.include_vault or coalesce(v_vault, false);
  new.leave_id := coalesce(new.leave_id, v_leave);

  update public.client_covers c
     set revoked_at = now(),
         revoked_by = new.granted_by,
         revoke_reason = 'Merged into a longer cover',
         merged_into = new.id
   where c.id = any (v_absorbed);

  return new;
end;
$$;

comment on function public.client_covers_merge() is
  '§4.7: overlapping covers for the same client (or absent person) and the same cover person merge into one; the later end wins; past 90 days is refused.';

create trigger client_covers_merge before insert on public.client_covers
  for each row execute function public.client_covers_merge();

revoke execute on function public.client_covers_merge() from public, anon, authenticated;
