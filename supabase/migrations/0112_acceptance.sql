-- 0112 · Client acceptance and the conflict check (§7.5.4, §6.8, §6.9 stage 1, §5.3 client_acceptances).
--
--   conflict_candidates(name, pan, gstin, related[], exclude_client, exclude_lead)
--       Partner/Manager, security invoker. Everything that might conflict with a prospect, for the
--       pure classifier in lib/domain/conflict.ts to decide on and explain:
--         clients (recycled ones too)  exact PAN / GSTIN (or the PAN inside the GSTIN), or a name
--                                      close to the prospect or to one of its related parties;
--         leads                        a name or company close to the prospect or a related party;
--         client contacts              a contact whose name is the prospect or a related party;
--         KYC principal persons        a client's director / partner / trustee whose name, PAN or
--                                      DIN is a related party or the prospect's PAN;
--         related parties              earlier acceptances' related parties that overlap;
--         client groups                a group whose name is close to the prospect or a party.
--       Similarity is pg_trgm on normalise_party_name (0111), with a broad 0.45 floor: the
--       classifier keeps only real matches and says why each one matched.
--   client_acceptances_guard
--       A decision (Accept / Decline) freezes the record with conflicts_found and the decider
--       (§7.5.4 "Frozen with conflicts_found and the decider"). Declining, or accepting despite a
--       match, needs a rationale. Afterwards only the link to the client or lead it produced may be
--       filled in.

set search_path = public, extensions;

-- =============================================================================================
-- conflict_candidates
-- =============================================================================================
create or replace function public.conflict_candidates(
  p_name text,
  p_pan text default null,
  p_gstin text default null,
  p_related text[] default '{}',
  p_exclude_client uuid default null,
  p_exclude_lead uuid default null
)
returns table (
  kind text,
  record_id uuid,
  client_id uuid,
  lead_id uuid,
  label text,
  code text,
  pan text,
  gstin text,
  din text,
  candidate_name text,
  target text,
  score numeric,
  in_recycle_bin boolean
)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_pan text := nullif(upper(regexp_replace(coalesce(p_pan, ''), '\s', '', 'g')), '');
  v_gstin text := nullif(upper(regexp_replace(coalesce(p_gstin, ''), '\s', '', 'g')), '');
  v_gstin_pan text;
  v_targets text[];
  v_ids text[];
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers run conflict checks.' using errcode = 'P0001';
  end if;
  if v_gstin is not null and length(v_gstin) = 15 then
    v_gstin_pan := substr(v_gstin, 3, 10);
  end if;

  -- Names to look for: the prospect and every related party (normalised), and identifiers among
  -- the related parties (a PAN or a DIN typed as a tag).
  select coalesce(array_agg(distinct n) filter (where n is not null), '{}')
    into v_targets
  from (
    select public.normalise_party_name(p_name) as n
    union all
    select public.normalise_party_name(t) from unnest(coalesce(p_related, '{}')) t
  ) s;
  select coalesce(array_agg(distinct upper(regexp_replace(t, '\s', '', 'g'))), '{}')
    into v_ids
  from unnest(coalesce(p_related, '{}')) t
  where upper(regexp_replace(t, '\s', '', 'g')) ~ '^([A-Z]{5}[0-9]{4}[A-Z]|[0-9]{8})$';

  -- Clients: exact identifiers.
  return query
  select 'client'::text, c.id, c.id, null::uuid, c.display_name, c.client_code::text, c.pan::text, c.gstin::text, null::text,
         c.display_name, null::text, 1.0::numeric, c.deleted_at is not null
  from public.clients c
  where (p_exclude_client is null or c.id <> p_exclude_client)
    and (
      (v_pan is not null and (c.pan = v_pan or c.gstin::text like '__' || v_pan || '___'))
      or (v_gstin is not null and c.gstin = v_gstin)
      or (v_gstin_pan is not null and c.pan = v_gstin_pan)
      or (cardinality(v_ids) > 0 and c.pan::text = any (v_ids))
    );

  -- Clients: names close to the prospect or a related party.
  return query
  select 'client'::text, c.id, c.id, null::uuid, c.display_name, c.client_code::text, c.pan::text, c.gstin::text, null::text,
         best.candidate, best.target, best.score, c.deleted_at is not null
  from public.clients c
  cross join lateral (
    select x.candidate, t as target, round(extensions.similarity(x.norm, t)::numeric, 3) as score
    from (values (c.display_name, public.normalise_party_name(c.display_name)), (c.legal_name, public.normalise_party_name(c.legal_name))) as x(candidate, norm)
    cross join unnest(v_targets) t
    where x.norm is not null
    order by extensions.similarity(x.norm, t) desc
    limit 1
  ) best
  where (p_exclude_client is null or c.id <> p_exclude_client)
    and best.score >= 0.45;

  -- Leads (not yet converted to the client being checked).
  return query
  select 'lead'::text, l.id, l.converted_client_id, l.id, coalesce(nullif(l.company, ''), l.name), l.lead_number, null::text, null::text, null::text,
         best.candidate, best.target, best.score, l.deleted_at is not null
  from public.leads l
  cross join lateral (
    select x.candidate, t as target, round(extensions.similarity(x.norm, t)::numeric, 3) as score
    from (values (l.name, public.normalise_party_name(l.name)), (l.company, public.normalise_party_name(l.company))) as x(candidate, norm)
    cross join unnest(v_targets) t
    where x.norm is not null
    order by extensions.similarity(x.norm, t) desc
    limit 1
  ) best
  where (p_exclude_lead is null or l.id <> p_exclude_lead)
    and best.score >= 0.45;

  -- Every client's contacts: a contact who is the prospect or one of its related parties.
  return query
  select 'contact'::text, cc.id, c.id, null::uuid, c.display_name, c.client_code::text, null::text, null::text, null::text,
         cc.name, best.target, best.score, c.deleted_at is not null
  from public.client_contacts cc
  join public.clients c on c.id = cc.client_id
  cross join lateral (
    select t as target, round(extensions.similarity(public.normalise_party_name(cc.name), t)::numeric, 3) as score
    from unnest(v_targets) t
    order by extensions.similarity(public.normalise_party_name(cc.name), t) desc
    limit 1
  ) best
  where (p_exclude_client is null or c.id <> p_exclude_client)
    and best.score >= 0.45;

  -- KYC principal persons (directors, partners, trustees) of every client.
  return query
  select 'kyc_person'::text, k.id, c.id, null::uuid, c.display_name, c.client_code::text,
         nullif(upper(pp ->> 'pan'), ''), null::text, nullif(pp ->> 'din', ''),
         pp ->> 'name', best.target, best.score, c.deleted_at is not null
  from public.client_kyc k
  join public.clients c on c.id = k.client_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(k.principal_persons) = 'array' then k.principal_persons else '[]'::jsonb end) pp
  cross join lateral (
    select t as target, round(extensions.similarity(public.normalise_party_name(pp ->> 'name'), t)::numeric, 3) as score
    from unnest(v_targets) t
    order by extensions.similarity(public.normalise_party_name(pp ->> 'name'), t) desc
    limit 1
  ) best
  where (p_exclude_client is null or c.id <> p_exclude_client)
    and (
      coalesce(best.score, 0) >= 0.45
      or (nullif(upper(pp ->> 'pan'), '') is not null and (upper(pp ->> 'pan') = any (v_ids) or upper(pp ->> 'pan') = v_pan))
      or (nullif(pp ->> 'din', '') is not null and (pp ->> 'din') = any (v_ids))
    );

  -- Related parties recorded on earlier acceptances (for clients and leads).
  return query
  select 'acceptance_party'::text, a.id, a.client_id, a.lead_id, a.prospect_name, null::text, a.pan::text, a.gstin::text, null::text,
         best.party, best.target, best.score, false
  from public.client_acceptances a
  cross join lateral (
    select rp as party, t as target, round(extensions.similarity(public.normalise_party_name(rp), t)::numeric, 3) as score
    from unnest(a.related_parties) rp
    cross join unnest(v_targets) t
    order by extensions.similarity(public.normalise_party_name(rp), t) desc
    limit 1
  ) best
  where (p_exclude_client is null or a.client_id is distinct from p_exclude_client)
    and (p_exclude_lead is null or a.lead_id is distinct from p_exclude_lead)
    and a.outcome <> 'declined'
    and best.score >= 0.45;

  -- Client groups (group companies).
  return query
  select 'group'::text, g.id, null::uuid, null::uuid, g.name::text, null::text, null::text, null::text, null::text,
         g.name::text, best.target, best.score, false
  from public.client_groups g
  cross join lateral (
    select t as target, round(extensions.similarity(public.normalise_party_name(g.name::text), t)::numeric, 3) as score
    from unnest(v_targets) t
    order by extensions.similarity(public.normalise_party_name(g.name::text), t) desc
    limit 1
  ) best
  where best.score >= 0.45;
end;
$$;

comment on function public.conflict_candidates(text, text, text, text[], uuid, uuid) is
  'Partner/Manager: possible conflicts for a prospect across clients (incl. recycle bin), leads, contacts, KYC principal persons, earlier related parties and client groups. Classified and explained by lib/domain/conflict.ts (§7.5.4).';

-- =============================================================================================
-- client_acceptances_guard: decisions freeze the record (§7.5.4)
-- =============================================================================================
create or replace function public.client_acceptances_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'UPDATE' and old.outcome <> 'pending' then
    if (to_jsonb(new) - array['client_id', 'lead_id', 'updated_at']) is distinct from (to_jsonb(old) - array['client_id', 'lead_id', 'updated_at'])
       or (old.client_id is not null and new.client_id is distinct from old.client_id)
       or (old.lead_id is not null and new.lead_id is distinct from old.lead_id) then
      raise exception 'USER: This acceptance decision is recorded and can''t be changed. Run a new conflict check instead.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.outcome = 'pending' then
    new.decided_by := null;
    new.decided_at := null;
    return new;
  end if;

  -- Deciding now (insert with a decision, or pending → accepted / declined).
  if new.conflicts_found is null or jsonb_typeof(new.conflicts_found) <> 'array' then
    raise exception 'USER: Run the conflict check before recording the decision.' using errcode = 'P0001';
  end if;
  if new.outcome = 'declined' and nullif(btrim(new.rationale), '') is null then
    raise exception 'USER: Give the reason for declining.' using errcode = 'P0001';
  end if;
  if new.outcome = 'accepted' and jsonb_array_length(new.conflicts_found) > 0 and nullif(btrim(new.rationale), '') is null then
    raise exception 'USER: Explain why you are accepting despite the matches the check found.' using errcode = 'P0001';
  end if;
  if public.is_api_caller() or auth.uid() is not null then
    new.decided_by := auth.uid();
  end if;
  new.decided_at := now();
  return new;
end;
$$;

comment on function public.client_acceptances_guard() is
  'Trigger: Accept/Decline freezes the acceptance with conflicts_found and the decider; declining, or accepting despite matches, needs a rationale (§7.5.4).';

drop trigger if exists client_acceptances_guard on public.client_acceptances;
create trigger client_acceptances_guard before insert or update on public.client_acceptances
  for each row execute function public.client_acceptances_guard();

create index if not exists client_acceptances_client_idx on public.client_acceptances (client_id) where client_id is not null;
create index if not exists client_acceptances_lead_idx on public.client_acceptances (lead_id) where lead_id is not null;

revoke execute on function public.client_acceptances_guard() from public, anon, authenticated;
revoke execute on function public.conflict_candidates(text, text, text, text[], uuid, uuid) from public, anon;
grant execute on function public.conflict_candidates(text, text, text, text[], uuid, uuid) to authenticated, service_role;
