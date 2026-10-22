-- 0005 · Sales pipeline: leads and quotations (§5.4, §7.5).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- leads (§5.4, §7.5.1)
-- ---------------------------------------------------------------------------------------------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  lead_number text unique,                     -- auto L-0001
  name text not null,
  company text,
  email citext,
  phone text,
  whatsapp text,
  services_required public.service_type[] not null default '{}',
  requirement_notes text,
  source public.lead_source not null default 'other',
  source_detail text,                          -- who referred them
  status public.lead_status not null default 'new_lead',
  estimated_value numeric(14,2) check (estimated_value >= 0),
  assigned_to uuid references public.employees (id) on delete set null,
  next_follow_up_at timestamptz,
  lost_reason text,                            -- required when lost
  converted_client_id uuid references public.clients (id) on delete set null,
  last_activity_at timestamptz not null default now(), -- §7.5.1: "untouched for 14 days" (maintained by trigger, 0017)
  created_by uuid not null,
  deleted_at timestamptz,
  deleted_by uuid,                             -- §7.19
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_has_contact_method check (
    nullif(btrim(email::text), '') is not null
    or nullif(btrim(phone), '') is not null
    or nullif(btrim(whatsapp), '') is not null
  ),
  constraint leads_lost_has_reason check (status <> 'lost' or nullif(btrim(lost_reason), '') is not null)
);
alter table public.leads enable row level security;

-- ---------------------------------------------------------------------------------------------
-- quotations (§5.4, §7.5.2–§7.5.3, §7.23)
-- token: 32 random bytes, URL-safe base64 without padding (43 characters).
-- ---------------------------------------------------------------------------------------------
create table public.quotations (
  id uuid primary key default gen_random_uuid(),
  quotation_number text not null unique,       -- from number_series, e.g. TW-Q/26-27/0007
  lead_id uuid references public.leads (id) on delete set null,
  client_id uuid references public.clients (id) on delete set null, -- quoting an existing client for extra work
  client_name text not null,
  client_email citext not null,
  client_phone text,
  client_company text,
  client_gstin citext,
  place_of_supply_code char(2) constraint quotations_pos_format check (place_of_supply_code ~ '^[0-9]{2}$'),
  issue_date date not null default public.today_ist(),
  valid_until date not null,
  status public.quotation_status not null default 'draft',
  notes text,
  terms text,
  subtotal numeric(14,2) not null default 0,
  tax_amount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  token text not null unique
    default rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '='),
  created_by uuid not null,
  approved_by uuid,
  approved_at timestamptz,
  approval_note text,                          -- §7.5.2: "Return with comments"
  sent_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count int not null default 0 check (view_count >= 0),
  responded_at timestamptz,
  response text constraint quotations_response_values check (response in ('accepted', 'rejected')),
  rejection_reason text,
  accepted_by_name text,                       -- the client types their name to accept
  response_ip text,
  converted_client_id uuid references public.clients (id) on delete set null,
  revised_from_id uuid references public.quotations (id) on delete set null,
  revision_number int not null default 0 check (revision_number >= 0),
  deleted_at timestamptz,
  deleted_by uuid,                             -- §7.19
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quotations_valid_after_issue check (valid_until >= issue_date),
  constraint quotations_token_length check (char_length(token) >= 32)
);
alter table public.quotations enable row level security;

create trigger normalize_identifiers before insert or update on public.quotations
  for each row execute function public.normalize_upper('client_gstin');

-- ---------------------------------------------------------------------------------------------
-- quotation_items (§5.4)
-- ---------------------------------------------------------------------------------------------
create table public.quotation_items (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references public.quotations (id) on delete cascade,
  description text not null,
  service_type public.service_type,
  frequency public.service_frequency,          -- so a converted engagement knows its cycle
  quantity numeric(10,2) not null default 1 check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  tax_rate numeric(5,2) not null default 18 check (tax_rate >= 0),
  tax_amount numeric(14,2) not null,
  total numeric(14,2) not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.quotation_items enable row level security;

-- ---------------------------------------------------------------------------------------------
-- quotation_email_logs (§5.4). The recipient column is literally named "to" (spec); quote it in SQL.
-- ---------------------------------------------------------------------------------------------
create table public.quotation_email_logs (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references public.quotations (id) on delete cascade,
  channel public.message_channel not null,
  email_type text not null constraint quotation_email_logs_type_values
    check (email_type in ('initial', 'follow_up_3', 'follow_up_7', 'follow_up_14', 'revision', 'acceptance_confirmation')),
  "to" text not null,
  subject text,
  status text not null constraint quotation_email_logs_status_values
    check (status in ('sent', 'handed_off', 'failed', 'delivered', 'opened', 'bounced')),
  provider_message_id text,
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.quotation_email_logs enable row level security;

-- ---------------------------------------------------------------------------------------------
-- quotation_follow_ups (§5.4, §7.5.3). Days come from firm_settings.quotation_follow_up_days.
-- ---------------------------------------------------------------------------------------------
create table public.quotation_follow_ups (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references public.quotations (id) on delete cascade,
  follow_up_day smallint not null check (follow_up_day > 0),
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  status text not null default 'pending' constraint quotation_follow_ups_status_values
    check (status in ('pending', 'sent', 'skipped', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quotation_follow_ups_quotation_day_key unique (quotation_id, follow_up_day) -- idempotent job (§8)
);
alter table public.quotation_follow_ups enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Foreign keys from 0004 tables to leads / quotations.
-- ---------------------------------------------------------------------------------------------
alter table public.clients
  add constraint clients_source_lead_id_fkey foreign key (source_lead_id) references public.leads (id) on delete set null,
  add constraint clients_source_quotation_id_fkey foreign key (source_quotation_id) references public.quotations (id) on delete set null;

alter table public.onboarding_drafts
  add constraint onboarding_drafts_source_lead_id_fkey foreign key (source_lead_id) references public.leads (id) on delete set null,
  add constraint onboarding_drafts_source_quotation_id_fkey foreign key (source_quotation_id) references public.quotations (id) on delete set null;

alter table public.client_services
  add constraint client_services_source_quotation_item_id_fkey
    foreign key (source_quotation_item_id) references public.quotation_items (id) on delete set null;

alter table public.client_acceptances
  add constraint client_acceptances_lead_id_fkey foreign key (lead_id) references public.leads (id) on delete set null,
  add constraint client_acceptances_client_id_fkey foreign key (client_id) references public.clients (id) on delete set null;

update public.app_meta set value = '0005' where key = 'schema_version';
