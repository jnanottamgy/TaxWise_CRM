-- 0010 · Communication: message templates, the per-client message history, delivery events,
-- portal message attachments (§5.9, §7.13, §7.22).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- message_templates (§5.9, §7.13.4, §16)
-- ---------------------------------------------------------------------------------------------
create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  name citext not null unique,
  type public.template_type not null default 'custom',
  channel text not null default 'any' constraint message_templates_channel_values check (channel in ('email', 'whatsapp', 'any')),
  subject text,                                -- email
  body text not null,                          -- with {{variables}} (§7.13.4)
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.message_templates enable row level security;

-- ---------------------------------------------------------------------------------------------
-- messages: the communication history per client, every channel (§5.9, §7.13.1)
-- ---------------------------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  contact_id uuid references public.client_contacts (id) on delete set null,
  channel public.message_channel not null,
  direction public.message_direction not null default 'outbound',
  recipient text,                              -- email address or normalised phone
  subject text,
  body text not null,
  template_id uuid references public.message_templates (id) on delete set null,
  status public.message_status not null,
  provider_message_id text,
  error text,
  related_entity_type text,
  related_entity_id uuid,
  sent_by uuid,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.messages enable row level security;

-- ---------------------------------------------------------------------------------------------
-- message_events (§5.9): delivery events (Resend webhooks, portal read receipts). Append-only.
-- ---------------------------------------------------------------------------------------------
create table public.message_events (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  status public.message_status not null,
  details jsonb,
  at timestamptz not null default now()
);
alter table public.message_events enable row level security;

-- ---------------------------------------------------------------------------------------------
-- message_attachments (§7.22: portal messages allow attachments; files live in the vault).
-- ---------------------------------------------------------------------------------------------
create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint message_attachments_message_document_key unique (message_id, document_id)
);
alter table public.message_attachments enable row level security;

update public.app_meta set value = '0010' where key = 'schema_version';
