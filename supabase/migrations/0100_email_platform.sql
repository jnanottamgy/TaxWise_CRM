-- 0100 · Platform services: the email delivery ledger, Resend webhook receipts, notification
-- de-duplication, and the guard that keeps the sending domain's status a mirror of Resend
-- (§7.13.1, §7.13.5, §8, §9, §10, §13).
--
--   email_deliveries        one row per email the app hands to Resend (server/email/send.ts), with
--                           the caller's idempotency key (unique: a job that runs twice never sends
--                           twice), the attempts, the provider id, and what the webhook reported
--                           since: delivered / opened / bounced / complained / failed. Client emails
--                           also get a `messages` row (the Communication history, §7.13.1); staff
--                           invites, digests and test sends have no client and live only here.
--                           Partner-only reads (Settings → Email delivery log, Diagnostics); written
--                           only by the service role.
--   email_webhook_events    one row per Resend webhook delivery (its svix id), so a retried webhook
--                           is applied once. Partner-only reads; written only by the service role.
--   notifications.dedupe_key  a job that runs twice notifies once: unique per (user, key).
--   firm_settings_email_domain_guard  resend_domain_id, domain_status, domain_verified_at and
--                           sending_domain change only through the service role, after Resend has
--                           answered (§7.13.5 "shows Verified only when Resend says so. It never sets
--                           'verified' locally"). Partners set them up through Settings → Email
--                           (server/actions/email-settings.ts), never by writing the row.

set search_path = public, extensions;

-- =============================================================================================
-- email_deliveries
-- =============================================================================================
create table public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null
    constraint email_deliveries_idempotency_key_key unique
    constraint email_deliveries_idempotency_key_length check (char_length(idempotency_key) between 1 and 256),
  kind text not null
    constraint email_deliveries_kind_format check (kind ~ '^[a-z][a-z0-9_]{1,47}$'),
  recipient text not null constraint email_deliveries_recipient_present check (btrim(recipient) <> ''),
  subject text not null,
  status text not null default 'queued'
    constraint email_deliveries_status_values
    check (status in ('queued', 'sent', 'delayed', 'delivered', 'opened', 'bounced', 'complained', 'failed')),
  attempts smallint not null default 0 constraint email_deliveries_attempts_range check (attempts between 0 and 20),
  provider_message_id text constraint email_deliveries_provider_message_id_key unique,
  error text,
  client_id uuid references public.clients (id) on delete cascade,
  contact_id uuid references public.client_contacts (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  related_entity_type text,
  related_entity_id uuid,
  sent_by uuid,                                -- profiles.id of whoever triggered it; null for jobs
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  failed_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.email_deliveries enable row level security;

comment on table public.email_deliveries is
  'Every email handed to Resend: idempotency key, attempts, provider id and the delivery events since (§7.13.5, §13). Partner reads; service role writes.';

create trigger set_updated_at before insert or update on public.email_deliveries
  for each row execute function public.set_updated_at();

create index email_deliveries_created_idx on public.email_deliveries (created_at desc);
create index email_deliveries_problem_idx on public.email_deliveries (created_at desc)
  where status in ('bounced', 'complained', 'failed');
create index email_deliveries_client_idx on public.email_deliveries (client_id) where client_id is not null;
create index email_deliveries_message_idx on public.email_deliveries (message_id) where message_id is not null;
create index email_deliveries_related_idx on public.email_deliveries (related_entity_type, related_entity_id)
  where related_entity_id is not null;

create policy email_deliveries_select_partner on public.email_deliveries
  for select to authenticated using ((select public.is_partner()));

revoke all on public.email_deliveries from anon;
revoke insert, update, delete, truncate on public.email_deliveries from authenticated;

-- =============================================================================================
-- email_webhook_events: one row per Resend webhook delivery (svix id), applied once.
-- =============================================================================================
create table public.email_webhook_events (
  id uuid primary key default gen_random_uuid(),
  webhook_id text not null
    constraint email_webhook_events_webhook_id_key unique
    constraint email_webhook_events_webhook_id_length check (char_length(webhook_id) between 1 and 200),
  event_type text not null,
  provider_message_id text,
  delivery_id uuid references public.email_deliveries (id) on delete cascade,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.email_webhook_events enable row level security;

comment on table public.email_webhook_events is
  'Resend webhook deliveries already applied (by svix id), so a retried webhook changes nothing twice (§7.13.5). Partner reads; service role writes.';

create trigger set_updated_at before insert or update on public.email_webhook_events
  for each row execute function public.set_updated_at();

create index email_webhook_events_created_idx on public.email_webhook_events (created_at desc);
create index email_webhook_events_delivery_idx on public.email_webhook_events (delivery_id) where delivery_id is not null;

create policy email_webhook_events_select_partner on public.email_webhook_events
  for select to authenticated using ((select public.is_partner()));

revoke all on public.email_webhook_events from anon;
revoke insert, update, delete, truncate on public.email_webhook_events from authenticated;

-- =============================================================================================
-- notifications.dedupe_key: a job that runs twice notifies once (§8 "Every job is idempotent").
-- =============================================================================================
alter table public.notifications
  add column dedupe_key text
  constraint notifications_dedupe_key_length check (dedupe_key is null or char_length(dedupe_key) between 1 and 200);

create unique index notifications_user_dedupe_key on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

comment on column public.notifications.dedupe_key is
  'Set by the sender (e.g. invoice_overdue:<id>:<date>); unique per recipient, so the same notice is never sent twice.';

-- =============================================================================================
-- firm_settings: the sending domain mirrors Resend (§5.2 domain_status "mirrors Resend, never set
-- locally", §7.13.5).
-- =============================================================================================
alter table public.firm_settings
  add constraint firm_settings_domain_verified_has_id
  check (domain_status is distinct from 'verified' or resend_domain_id is not null);

create or replace function public.firm_settings_email_domain_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  -- The service role (server/actions/email-settings.ts, after Resend answered), migrations and the
  -- seed pass; the API roles never set these columns themselves.
  if not public.is_api_caller() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.resend_domain_id is not null
       or coalesce(new.domain_status, 'not_started') <> 'not_started'
       or new.domain_verified_at is not null then
      raise exception 'USER: The sending domain''s status comes from Resend. Set it up in Settings → Email.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.resend_domain_id is distinct from old.resend_domain_id
     or new.domain_status is distinct from old.domain_status
     or new.domain_verified_at is distinct from old.domain_verified_at
     or new.sending_domain is distinct from old.sending_domain then
    raise exception 'USER: The sending domain and its status come from Resend. Change them in Settings → Email.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.firm_settings_email_domain_guard() is
  'Trigger: only the service role changes sending_domain, resend_domain_id, domain_status and domain_verified_at, after Resend has answered (§7.13.5).';

create trigger firm_settings_email_domain_guard before insert or update on public.firm_settings
  for each row execute function public.firm_settings_email_domain_guard();

revoke execute on function public.firm_settings_email_domain_guard() from public, anon, authenticated;
