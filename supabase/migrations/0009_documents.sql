-- 0009 · Documents vault and document requests (§5.8, §6.8 retention, §7.14, §7.22).
-- Also adds the document FKs from earlier tables.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- documents (§5.8)
-- ---------------------------------------------------------------------------------------------
create table public.documents (
  -- What
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete restrict, -- retention blocks purge (§6.8, §7.19)
  title text not null,
  category public.document_category not null default 'other',
  financial_year text constraint documents_financial_year_format check (public.is_fy_label(financial_year)),
  period text,
  description text,

  -- The file
  file_name text not null,
  file_size int not null constraint documents_file_size_limit check (file_size > 0 and file_size <= 26214400), -- 25 MB
  mime_type text not null,
  storage_path text not null unique,           -- bucket client-documents/<client_id>/<uuid>.<ext>
  sha256 text constraint documents_sha256_format check (sha256 ~* '^[0-9a-f]{64}$'), -- duplicate warning
  version int not null default 1 check (version >= 1),

  -- Origin and handling
  source text not null default 'staff'
    constraint documents_source_values check (source in ('staff', 'client_portal', 'generated', 'email', 'whatsapp')),
  is_confidential boolean not null default false, -- hidden from Employees unless they're on the client team
  shareable_with_client boolean not null default false, -- §7.22: shared documents from the firm in the portal
  uploaded_by uuid not null,

  -- Dates
  expiry_date date,
  renewal_date date,
  retention_until date default (public.today_ist() + interval '7 years')::date, -- §5.8 default; longest rule wins (§6.8)
  deleted_at timestamptz,
  deleted_by uuid,                             -- §7.19
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.documents enable row level security;

-- ---------------------------------------------------------------------------------------------
-- document_versions (§5.8). Append-only.
-- ---------------------------------------------------------------------------------------------
create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  version int not null check (version >= 1),
  file_name text not null,
  file_size int not null check (file_size > 0 and file_size <= 26214400),
  storage_path text not null,
  uploaded_by uuid not null,
  change_note text,
  created_at timestamptz not null default now(),
  constraint document_versions_document_version_key unique (document_id, version)
);
alter table public.document_versions enable row level security;

-- ---------------------------------------------------------------------------------------------
-- document_tags (§5.8)
-- ---------------------------------------------------------------------------------------------
create table public.document_tags (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  tag citext not null check (btrim(tag::text) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_tags_document_tag_key unique (document_id, tag)
);
alter table public.document_tags enable row level security;

-- ---------------------------------------------------------------------------------------------
-- document_activities (§5.8): every view and download is logged (§7.14). Append-only.
-- ---------------------------------------------------------------------------------------------
create table public.document_activities (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null,
  activity public.document_activity not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);
alter table public.document_activities enable row level security;

-- ---------------------------------------------------------------------------------------------
-- document_requests: PBC lists sent to clients (§5.8, §7.14)
-- ---------------------------------------------------------------------------------------------
create table public.document_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  title text not null,
  status public.request_status not null default 'open',
  due_date date,
  notes text,
  created_by uuid not null,
  last_reminded_at timestamptz,
  reminder_every_days int not null default 3 check (reminder_every_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.document_requests enable row level security;

create table public.document_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.document_requests (id) on delete cascade,
  title text not null,
  help_text text,
  is_required boolean not null default true,
  status public.request_item_status not null default 'pending',
  document_id uuid references public.documents (id) on delete set null,
  rejection_reason text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_request_items_rejection_has_reason
    check (status <> 'rejected' or nullif(btrim(rejection_reason), '') is not null)
);
alter table public.document_request_items enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Document FKs from earlier tables.
-- ---------------------------------------------------------------------------------------------
alter table public.client_document_checklist_items
  add constraint client_document_checklist_items_document_id_fkey
    foreign key (document_id) references public.documents (id) on delete set null;

alter table public.task_attachments
  add constraint task_attachments_document_id_fkey
    foreign key (document_id) references public.documents (id) on delete cascade;

alter table public.filing_records
  add constraint filing_records_document_id_fkey
    foreign key (document_id) references public.documents (id) on delete set null;

alter table public.engagement_letters
  add constraint engagement_letters_document_id_fkey
    foreign key (document_id) references public.documents (id) on delete set null;

alter table public.portal_payment_claims
  add constraint portal_payment_claims_screenshot_document_id_fkey
    foreign key (screenshot_document_id) references public.documents (id) on delete set null;

update public.app_meta set value = '0009' where key = 'schema_version';
