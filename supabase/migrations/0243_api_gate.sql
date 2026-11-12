-- 0243 · The database API answers only the firm's own app (§12).
--
-- What the end-to-end break-it run showed: the publishable key ships to every browser, so anyone with
-- a login (staff or a portal client) could skip the app and call the database API directly with their
-- own session. Row-level security still applied, but every rule that lives in the app's server
-- actions did not: a Manager could renumber or hide an issued invoice, forge a colleague's acceptance
-- of a task, rewrite time entries; an Employee could write audit rows; a client could put unchecked
-- files in the vault. About twenty findings, one cause.
--
-- The fix is one gate in front of the whole API (PostgREST `db_pre_request`, which runs before every
-- REST, RPC and GraphQL request): a request made as `authenticated` or `anon` must carry the app
-- server's token in the `x-taxwise-app` header. The token never reaches a browser: the app's server
-- derives it from a server-only secret and adds it to its own database calls (lib/supabase/app-gate.ts).
-- The database keeps only SHA-256 hashes of the tokens it accepts. The service role (the app's own
-- admin client and scheduled jobs) and direct database connections are not affected. File storage is
-- covered by a matching policy on storage.objects (below). Supabase Auth has its own door and rules
-- and is not behind this gate.
--
-- Rollout is safe by construction: the gate starts open (`enforce = false`). The app's scheduler
-- (server/api-gate.ts, every 15 minutes) registers its token, proves through the API that the
-- database recognises it, and only then switches enforcement on. If the token ever changes, the app
-- registers the new one and carries on. To switch the gate off by hand:
--   update private.api_gate set enforce = false;
-- (or set API_GATE=off in the app's environment: the next scheduler check opens it).
--
-- Also records the schema version (§0.1 rule 1): lib/env.ts EXPECTED_SCHEMA_VERSION matches it.

set search_path = public, extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

create table if not exists private.api_gate (
  id boolean primary key default true constraint api_gate_one_row check (id),
  enforce boolean not null default false,
  -- SHA-256 (hex) of each token accepted, newest first; a few are kept so a change of secret
  -- doesn't cut off instances still running with the previous one.
  token_hashes text[] not null default '{}',
  armed_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into private.api_gate (id) values (true) on conflict (id) do nothing;
revoke all on table private.api_gate from public, anon, authenticated;

-- True when the token is one of the registered ones.
create or replace function private.api_gate_knows(p_token text)
returns boolean
language sql
stable
security definer
set search_path = private, public, extensions
as $$
  select p_token is not null and length(p_token) between 32 and 200
     and exists (
       select 1 from private.api_gate g
        where encode(sha256(convert_to(p_token, 'UTF8')), 'hex') = any (g.token_hashes)
     )
$$;

-- True when the request may go on: the gate is open, or the token is known.
create or replace function private.api_gate_passes(p_token text)
returns boolean
language sql
stable
security definer
set search_path = private, public, extensions
as $$
  select coalesce((select not g.enforce from private.api_gate g), true) or private.api_gate_knows(p_token)
$$;

revoke execute on function private.api_gate_knows(text), private.api_gate_passes(text) from public, anon, authenticated;
grant execute on function private.api_gate_knows(text), private.api_gate_passes(text) to anon, authenticated, service_role;

-- The token a request carries, or null.
create or replace function public.api_gate_request_token()
returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_headers json;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  return v_headers ->> 'x-taxwise-app';
end;
$$;

-- The pre-request check. SECURITY INVOKER on purpose: current_user is the request's role.
create or replace function public.api_gate()
returns void
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return; -- the service role and the database's own roles
  end if;
  if private.api_gate_passes(public.api_gate_request_token()) then
    return;
  end if;
  raise sqlstate 'PT403' using
    message = 'TWGATE: This database answers only the TaxWise app.',
    hint = 'Use the app. A direct call needs the app server''s token.';
end;
$$;

comment on function public.api_gate() is
  'PostgREST db_pre_request: an authenticated/anon request must carry the app server''s token (x-taxwise-app) once the gate is enforced. See 0243 and lib/supabase/app-gate.ts.';

-- The canary the app calls through the API with its token: true when the database recognises it.
create or replace function public.api_gate_sees_app()
returns boolean
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select private.api_gate_knows(public.api_gate_request_token())
$$;

-- The app's server registers its token's hash and, once the canary has passed, enforcement.
-- p_enforce: true / false sets it; null leaves it as it is.
create or replace function public.api_gate_register(p_token_hash text, p_enforce boolean default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = private, public, extensions
as $$
declare
  g private.api_gate%rowtype;
  v_hashes text[];
begin
  if p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'USER: The token hash must be 64 hexadecimal characters.' using errcode = 'P0001';
  end if;
  select * into g from private.api_gate where id for update;
  v_hashes := g.token_hashes;
  if p_token_hash is not null and not (p_token_hash = any (v_hashes)) then
    v_hashes := (array[p_token_hash] || v_hashes)[1:3];
  end if;
  if coalesce(p_enforce, g.enforce) and cardinality(v_hashes) = 0 then
    raise exception 'USER: Register the app''s token before switching the gate on.' using errcode = 'P0001';
  end if;
  update private.api_gate
     set token_hashes = v_hashes,
         enforce = coalesce(p_enforce, enforce),
         armed_at = case
           when coalesce(p_enforce, enforce) and not enforce then now()
           when not coalesce(p_enforce, enforce) then null
           else armed_at
         end,
         updated_at = now()
   where id
  returning * into g;
  return jsonb_build_object('enforce', g.enforce, 'tokens', cardinality(g.token_hashes), 'armed_at', g.armed_at);
end;
$$;

-- What Settings → Diagnostics shows.
create or replace function public.api_gate_status()
returns jsonb
language sql
stable
security definer
set search_path = private, public, extensions
as $$
  select jsonb_build_object(
    'enforce', g.enforce,
    'tokens', cardinality(g.token_hashes),
    'armed_at', g.armed_at,
    'hook', exists (
      select 1
        from pg_db_role_setting s
        join pg_roles r on r.oid = s.setrole
       where r.rolname = 'authenticator'
         and exists (select 1 from unnest(s.setconfig) c where c like 'pgrst.db_pre_request=%api_gate%')
    )
  )
  from private.api_gate g
$$;

-- Supabase's default privileges hand every new function in `public` to anon and authenticated, so
-- the two that only the app's server may call are revoked from them by name.
revoke execute on function
  public.api_gate(), public.api_gate_request_token(), public.api_gate_sees_app(),
  public.api_gate_register(text, boolean), public.api_gate_status()
from public, anon, authenticated;
grant execute on function public.api_gate(), public.api_gate_request_token(), public.api_gate_sees_app()
  to anon, authenticated, service_role;
grant execute on function public.api_gate_register(text, boolean), public.api_gate_status() to service_role;

-- File storage has its own API, which doesn't pass through the pre-request check, but it hands the
-- request's headers to the database when it evaluates the policies on storage.objects. A restrictive
-- policy there applies the same rule: with a login alone (no app token) nobody lists, reads, signs,
-- uploads, moves or deletes a stored file. Downloads and uploads through the short-lived signed
-- links the app hands out, and the public branding bucket, are checked by the storage service
-- itself and don't evaluate these policies, so they work as before.
drop policy if exists api_gate_objects on storage.objects;
create policy api_gate_objects on storage.objects
  as restrictive
  for all
  to authenticated, anon
  using (private.api_gate_passes(public.api_gate_request_token()))
  with check (private.api_gate_passes(public.api_gate_request_token()));

-- Put the gate in front of the API. On Supabase the API server signs in as `authenticator` and reads
-- its settings from that role; the test databases have no such role and no API in front of them.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    begin
      execute 'alter role authenticator set pgrst.db_pre_request = ''public.api_gate''';
    exception when others then
      raise notice 'api gate: could not set pgrst.db_pre_request on authenticator (%). Run it in the SQL editor: alter role authenticator set pgrst.db_pre_request = ''public.api_gate''; notify pgrst, ''reload config'';', sqlerrm;
    end;
  end if;
end
$$;
notify pgrst, 'reload config';

update public.app_meta set value = '0243' where key = 'schema_version';
