/**
 * Fixtures for the database test suite (§14 "Database tests").
 *
 * Every test database gets the same cast, inserted as the superuser (RLS bypassed):
 *
 *   P1, P2   Partners                         M1, M2   Managers
 *   E1       Employee, owner of client A (and of the deleted client Z)
 *   E2       Employee on client B's engagement team
 *   E3       Employee with no clients (the cover person in cover tests; holds an expired cover for A)
 *   E4       Employee, owner of client B
 *   X        JWT app_metadata says 'partner' but profiles.role is 'employee'; on client C's team
 *   D        disabled Employee (profiles.is_active = false), on client A's team
 *   CA       portal user of client A
 *   CB       portal user of client B, with user_metadata.role = 'partner' in auth.users
 *
 *   Client A (owner E1, team D, portal CA) · Client B (owner E4, team E2, portal CB)
 *   Client C (owner M1's employee row, team X) · Client Z (owner E1, soft-deleted)
 *
 * Clients A, B and C each get a row in nearly every client-owned table (contacts, services with
 * fees, deadlines, documents, messages, tasks, invoices, receipts, credit notes, quotations,
 * engagement letters, credentials, WhatsApp groups, workpapers, registers …), so "sees nothing it
 * shouldn't" is never vacuously true. IDs are deterministic (fid('client:A')).
 */
import { createHash } from "node:crypto";

export type AppRoleName = "partner" | "manager" | "employee" | "client";

/** A deterministic UUID for a fixture name, e.g. fid('client:A'). */
export function fid(name: string): string {
  const h = createHash("md5").update(`taxwise-fixture:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type TestUser = {
  key: UserKey;
  /** auth.users.id = profiles.id */
  id: string;
  email: string;
  fullName: string;
  /** The role the JWT's app_metadata carries by default. */
  jwtRole: AppRoleName;
  /** profiles.role (the authority, §0.1 rule 9). */
  profileRole: AppRoleName;
  isActive: boolean;
  /** employees.id for staff, else null. */
  employeeId: string | null;
  /** auth.users.raw_user_meta_data (also sent as the JWT's user_metadata). */
  userMetadata: Record<string, unknown>;
};

export type UserKey = "P1" | "P2" | "M1" | "M2" | "E1" | "E2" | "E3" | "E4" | "X" | "D" | "CA" | "CB";

function user(key: UserKey, jwtRole: AppRoleName, profileRole: AppRoleName, extra: Partial<TestUser> = {}): TestUser {
  const staff = profileRole !== "client";
  return {
    key,
    id: fid(`user:${key}`),
    email: `${key.toLowerCase()}@taxwise.test`,
    fullName: `Test ${key}`,
    jwtRole,
    profileRole,
    isActive: true,
    employeeId: staff ? fid(`employee:${key}`) : null,
    userMetadata: { full_name: `Test ${key}` },
    ...extra,
  };
}

/** The cast (see the file header). */
export const U: Record<UserKey, TestUser> = {
  P1: user("P1", "partner", "partner"),
  P2: user("P2", "partner", "partner"),
  M1: user("M1", "manager", "manager"),
  M2: user("M2", "manager", "manager"),
  E1: user("E1", "employee", "employee"),
  E2: user("E2", "employee", "employee"),
  E3: user("E3", "employee", "employee"),
  E4: user("E4", "employee", "employee"),
  X: user("X", "partner", "employee"),
  D: user("D", "employee", "employee", { isActive: false }),
  CA: user("CA", "client", "client"),
  CB: user("CB", "client", "client", { userMetadata: { full_name: "Test CB", role: "partner" } }),
};

export type ClientKey = "A" | "B" | "C" | "Z";

/** Client ids. */
export const C: Record<ClientKey, string> = {
  A: fid("client:A"),
  B: fid("client:B"),
  C: fid("client:C"),
  Z: fid("client:Z"),
};

/** The live clients each role-holder may see (§4.1 Employee scope, §7.22 portal). */
export const VISIBLE_CLIENTS: Record<UserKey, ClientKey[]> = {
  P1: ["A", "B", "C", "Z"],
  P2: ["A", "B", "C", "Z"],
  M1: ["A", "B", "C", "Z"],
  M2: ["A", "B", "C", "Z"],
  E1: ["A"],
  E2: ["B"],
  E3: [],
  E4: ["B"],
  X: [],
  D: [],
  CA: ["A"],
  CB: ["B"],
};

/** Fixture row ids used by tests. */
export const F = {
  task: (k: "A" | "B" | "C") => fid(`task:${k}`),
  invoiceSent: (k: "A" | "B" | "C") => fid(`invoice:${k}:sent`),
  invoiceDraft: (k: "A" | "B" | "C") => fid(`invoice:${k}:draft`),
  service: (k: "A" | "B" | "C") => fid(`service:${k}`),
  credential: (k: "A" | "B" | "C") => fid(`credential:${k}`),
  waGroup: (k: "A" | "B" | "C") => fid(`wa-group:${k}`),
  docShared: (k: "A" | "B" | "C") => fid(`document:${k}:shared`),
  docPrivate: (k: "A" | "B" | "C") => fid(`document:${k}:private`),
  device: fid("desktop-device:1"),
  expiredCover: fid("cover:expired"),
  auditLog: fid("audit-log:1"),
};

/** Which employee row is assigned the fixture task of each client (accepted, In progress). */
export const TASK_ASSIGNEE: Record<"A" | "B" | "C", UserKey> = { A: "E1", B: "E2", C: "M2" };

const q = (s: string | null) => (s === null ? "null" : `'${s.replace(/'/g, "''")}'`);

function usersSql(): string {
  const out: string[] = [];
  for (const u of Object.values(U)) {
    out.push(
      `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, email_confirmed_at)
       values (${q(u.id)}, ${q(u.email)}, ${q(JSON.stringify({ role: u.jwtRole, provider: "email" }))}::jsonb,
               ${q(JSON.stringify(u.userMetadata))}::jsonb, now());`,
      `insert into public.profiles (id, full_name, email, role, is_active)
       values (${q(u.id)}, ${q(u.fullName)}, ${q(u.email)}, ${q(u.profileRole)}, ${u.isActive});`,
    );
    if (u.employeeId) {
      out.push(
        `insert into public.employees (id, profile_id, full_name, email, staff_role, is_active, billing_rate_per_hour, cost_rate_per_hour, vault_access)
         values (${q(u.employeeId)}, ${q(u.id)}, ${q(u.fullName)}, ${q(u.email)}, ${q(u.profileRole)}, ${u.isActive}, 2000, 900, ${u.key === "E1"});`,
      );
    }
  }
  return out.join("\n");
}

function clientsSql(): string {
  const e = (k: UserKey) => q(U[k].employeeId);
  return `
    insert into public.client_groups (id, name) values (${q(fid("group:1"))}, 'Test group');
    insert into public.clients (id, client_code, display_name, entity_type, owner_employee_id, portal_user_id, notes, group_id, status)
    values
      (${q(C.A)}, 'TW-C-9001', 'Alpha Traders', 'proprietorship', ${e("E1")}, ${q(U.CA.id)}, 'internal note A', ${q(fid("group:1"))}, 'active'),
      (${q(C.B)}, 'TW-C-9002', 'Beta Industries', 'pvt_ltd', ${e("E4")}, ${q(U.CB.id)}, 'internal note B', null, 'active'),
      (${q(C.C)}, 'TW-C-9003', 'Gamma LLP', 'llp', ${e("M1")}, null, 'internal note C', null, 'active'),
      (${q(C.Z)}, 'TW-C-9004', 'Zeta (deleted)', 'individual', ${e("E1")}, null, 'internal note Z', null, 'inactive');
    update public.clients set deleted_at = now() - interval '1 day', deleted_by = ${q(U.P1.id)} where id = ${q(C.Z)};
    insert into public.client_team_members (client_id, employee_id, team_role) values
      (${q(C.A)}, ${e("D")}, 'preparer'),
      (${q(C.B)}, ${e("E2")}, 'preparer'),
      (${q(C.C)}, ${e("X")}, 'preparer');
  `;
}

/** One row (or two) in nearly every client-owned table for client k. */
function perClientSql(k: "A" | "B" | "C"): string {
  const cid = q(C[k]);
  const p1 = q(U.P1.id);
  const assignee = q(U[TASK_ASSIGNEE[k]].employeeId);
  const portalUser = k === "A" ? q(U.CA.id) : k === "B" ? q(U.CB.id) : "null";
  return `
    insert into public.client_contacts (id, client_id, name, email) values (${q(fid(`contact:${k}`))}, ${cid}, 'Contact ${k}', 'contact.${k.toLowerCase()}@example.com');
    insert into public.client_services (id, client_id, service_type, frequency, agreed_fee, billing_frequency, sac_code, auto_invoice, next_billing_date)
      values (${q(F.service(k))}, ${cid}, 'gst', 'monthly', 5000, 'monthly', '998231', true, '2026-11-01');
    insert into public.client_kyc (client_id, entity_category) values (${cid}, 'corporate');
    insert into public.client_document_checklist_items (client_id, label) values (${cid}, 'PAN card ${k}');
    insert into public.client_credentials (id, client_id, portal, username, password_ciphertext)
      values (${q(F.credential(k))}, ${cid}, 'GST', 'user_${k}', 'v1:iv${k}.tag${k}.cipher${k}');
    insert into public.credential_access_logs (credential_id, user_id, action) values (${q(F.credential(k))}, ${p1}, 'created');

    insert into public.compliance_events (id, client_id, type, title, due_date, source, is_statutory, financial_year)
      values (${q(fid(`ce:${k}:stat`))}, ${cid}, 'gstr_3b', 'GSTR-3B ${k}', '2026-11-20', 'statutory_engine', true, '2026-27'),
             (${q(fid(`ce:${k}:ops`))}, ${cid}, 'custom', 'Internal follow-up ${k}', '2026-11-25', 'manual', false, '2026-27');

    insert into public.documents (id, client_id, title, file_name, file_size, mime_type, storage_path, uploaded_by, shareable_with_client, category)
      values (${q(F.docShared(k))}, ${cid}, 'Shared ${k}', 'shared.pdf', 100, 'application/pdf', 'client-documents/' || ${cid} || '/shared.pdf', ${p1}, true, 'gst'),
             (${q(F.docPrivate(k))}, ${cid}, 'Private ${k}', 'private.pdf', 100, 'application/pdf', 'client-documents/' || ${cid} || '/private.pdf', ${p1}, false, 'gst');
    insert into public.document_versions (document_id, version, file_name, file_size, storage_path, uploaded_by)
      values (${q(F.docPrivate(k))}, 1, 'private.pdf', 100, 'client-documents/' || ${cid} || '/private-v1.pdf', ${p1});
    insert into public.document_tags (document_id, tag) values (${q(F.docPrivate(k))}, 'tag-${k}');
    insert into public.document_activities (document_id, user_id, activity) values (${q(F.docPrivate(k))}, ${p1}, 'uploaded');
    insert into public.document_requests (id, client_id, title, created_by) values (${q(fid(`docreq:${k}`))}, ${cid}, 'PBC ${k}', ${p1});
    insert into public.document_request_items (request_id, title) values (${q(fid(`docreq:${k}`))}, 'Bank statement ${k}');

    insert into public.messages (id, client_id, channel, direction, body, status, sent_by)
      values (${q(fid(`msg:${k}:portal`))}, ${cid}, 'portal', 'outbound', 'Portal hello ${k}', 'sent', ${p1}),
             (${q(fid(`msg:${k}:email`))}, ${cid}, 'email', 'outbound', 'Email hello ${k}', 'sent', ${p1}),
             (${q(fid(`msg:${k}:note`))}, ${cid}, 'internal_note', 'outbound', 'Internal note ${k}', 'sent', ${p1});
    insert into public.messages (id, client_id, channel, direction, body, status, sent_by, related_entity_type, related_entity_id)
      values (${q(fid(`msg:${k}:invoice`))}, ${cid}, 'email', 'outbound', 'Invoice for Rs 5,900 ${k}', 'sent', ${p1}, 'invoice', ${q(F.invoiceSent(k))});
    insert into public.message_events (message_id, status) values (${q(fid(`msg:${k}:email`))}, 'delivered');
    insert into public.message_attachments (message_id, document_id) values (${q(fid(`msg:${k}:portal`))}, ${q(F.docShared(k))});

    insert into public.tasks (id, task_number, client_id, title, status, assigned_employee_id, acceptance_status, accepted_at, created_by, due_date)
      values (${q(F.task(k))}, 'T-90000${k === "A" ? 1 : k === "B" ? 2 : 3}', ${cid}, 'GST return ${k}', 'in_progress', ${assignee}, 'accepted', now(), ${p1}, '2026-11-20');
    insert into public.task_comments (task_id, author_id, body) values (${q(F.task(k))}, ${p1}, 'Comment ${k}');
    insert into public.task_checklist_items (task_id, title) values (${q(F.task(k))}, 'Step ${k}');
    insert into public.task_attachments (task_id, document_id, uploaded_by) values (${q(F.task(k))}, ${q(F.docPrivate(k))}, ${p1});
    insert into public.task_status_history (task_id, from_status, to_status, changed_by) values (${q(F.task(k))}, 'not_started', 'in_progress', ${p1});
    insert into public.task_automations (client_id, type, frequency) values (${cid}, 'reminder', 'monthly');

    insert into public.filing_records (client_id, financial_year, filing_type, shareable_with_client, created_by)
      values (${cid}, '2026-27', 'GSTR-3B', true, ${p1}), (${cid}, '2026-27', 'GSTR-1', false, ${p1});
    insert into public.statutory_registrations (client_id, registration_type, registration_number) values (${cid}, 'PT', 'PT-${k}');
    insert into public.dsc_records (client_id, holder_name, expiry_date) values (${cid}, 'Holder ${k}', '2027-06-30');
    insert into public.udin_records (client_id, udin, document_type, document_date, signed_on, generated_on, signing_partner_id, report_form, financial_year)
      values (${cid}, '26123456ABCDEF${k}${k}${k}${k}', 'Tax audit report', '2026-09-30', '2026-09-30', '2026-09-30', ${p1}, '3CA', '2025-26');
    insert into public.gst_recon_runs (id, client_id, period, summary, created_by) values (${q(fid(`recon:${k}`))}, ${cid}, '092026', '{}', ${p1});
    insert into public.gst_recon_entries (run_id, bucket, supplier_gstin, data) values (${q(fid(`recon:${k}`))}, 'matched', '29AAXFT1811B1Z3', '{}');
    insert into public.itr_computations (client_id, financial_year, inputs, results, created_by) values (${cid}, '2025-26', '{}', '{}', ${p1});
    insert into public.financial_statements (client_id, financial_year, ledgers, statements, created_by) values (${cid}, '2025-26', '[]', '{}', ${p1});
    insert into public.tax_notices (id, client_id, notice_type, created_by) values (${q(fid(`notice:${k}`))}, ${cid}, 'scrutiny', ${p1});
    insert into public.tax_notice_documents (notice_id, document_id) values (${q(fid(`notice:${k}`))}, ${q(F.docPrivate(k))});
    insert into public.register_portal_mappings (client_id, kind, mapping) values (${cid}, 'purchase_register', '{}');
    insert into public.client_timeline_events (client_id, event_type, title, performed_by)
      values (${cid}, 'task_created', 'Task created ${k}', ${p1}),
             (${cid}, 'invoice_sent', 'Invoice sent ${k}: Rs 5,900', ${p1}),
             (${cid}, 'payment_received', 'Payment received ${k}: Rs 5,900', ${p1}),
             (${cid}, 'quotation_sent', 'Quotation sent ${k}: Rs 12,000', ${p1});
    insert into public.activity_logs (entity_type, entity_id, action, description, user_id) values ('client', ${cid}, 'updated', 'Edited ${k}', ${p1});

    insert into public.client_whatsapp_groups (id, client_id, name, invite_link, status, is_primary)
      values (${q(F.waGroup(k))}, ${cid}, 'TW · ${k}', 'https://chat.whatsapp.com/invite${k}', 'active', true);
    insert into public.client_whatsapp_group_members (group_id, kind, display_name, number) values (${q(F.waGroup(k))}, 'client_contact', 'Contact ${k}', '919876543210');

    -- Money (§4.6): a sent invoice with a line, a draft, a receipt / credit note, reminders.
    insert into public.invoices (id, client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by, client_service_id, billing_period_label)
      values (${q(F.invoiceSent(k))}, ${cid}, '2026-09-01', '2026-09-15', 'sent', '29', 5000, 450, 450, 5900, ${p1}, ${q(F.service(k))}, 'Sep 2026');
    insert into public.invoices (id, client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
      values (${q(F.invoiceDraft(k))}, ${cid}, '2026-09-01', '2026-09-15', 'draft', '29', 1000, 90, 90, 1180, ${p1});
    insert into public.invoice_items (invoice_id, description, sac_code, rate, amount, tax_rate)
      values (${q(F.invoiceDraft(k))}, 'GST compliance ${k}', '998231', 1000, 1000, 18);
    insert into public.invoice_follow_ups (invoice_id, channel, notes, by_user) values (${q(F.invoiceSent(k))}, 'call', 'Called ${k}', ${p1});
    insert into public.invoice_reminders (invoice_id, kind, scheduled_for, channel) values (${q(F.invoiceSent(k))}, 'after_due', now(), 'email');
    insert into public.payment_receipts (receipt_number, invoice_id, payment_date, amount_received, tds_amount, method, recorded_by)
      values ('TW-R/26-27/90${k === "A" ? 1 : k === "B" ? 2 : 3}', ${q(F.invoiceSent(k))}, '2026-09-20', 1000, 0, 'upi', ${p1});
    insert into public.credit_notes (credit_note_number, invoice_id, client_id, reason_code, reason, taxable_amount, total_amount, issued_by)
      values ('TW-CN/26-27/90${k === "A" ? 1 : k === "B" ? 2 : 3}', ${q(F.invoiceSent(k))}, ${cid}, 'goodwill', 'Goodwill ${k}', 100, 118, ${p1});
    ${portalUser !== "null" ? `insert into public.portal_payment_claims (invoice_id, client_id, created_by) values (${q(F.invoiceSent(k))}, ${cid}, ${portalUser});` : ""}

    insert into public.quotations (id, quotation_number, client_id, client_name, client_email, valid_until, issue_date, created_by, total)
      values (${q(fid(`quotation:${k}`))}, 'TW-Q/26-27/90${k === "A" ? 1 : k === "B" ? 2 : 3}', ${cid}, 'Client ${k}', 'q.${k.toLowerCase()}@example.com', '2026-12-31', '2026-10-01', ${p1}, 11800);
    insert into public.quotation_items (quotation_id, description, unit_price, tax_amount, total) values (${q(fid(`quotation:${k}`))}, 'Retainer ${k}', 10000, 1800, 11800);
    insert into public.quotation_email_logs (quotation_id, channel, email_type, "to", status) values (${q(fid(`quotation:${k}`))}, 'email', 'initial', 'q@example.com', 'sent');
    insert into public.quotation_follow_ups (quotation_id, follow_up_day, scheduled_at) values (${q(fid(`quotation:${k}`))}, 3, now());
    insert into public.engagement_letters (client_id, financial_year, service_types, fee_agreed) values (${cid}, '2026-27', '{gst}', 60000);
    insert into public.client_acceptances (prospect_name, client_id, created_by) values ('Prospect ${k}', ${cid}, ${p1});
    insert into public.previous_auditor_communications (client_id, engagement_type, previous_auditor_name, letter_sent_on) values (${cid}, 'statutory', 'Old auditor ${k}', '2026-04-10');
    insert into public.audit_engagements (client_id, audit_type, financial_year, engagement_partner_id) values (${cid}, 'tax_audit', '2025-26', ${p1});
  `;
}

function firmWideSql(): string {
  const p1 = q(U.P1.id);
  const e = (k: UserKey) => q(U[k].employeeId);
  return `
    insert into public.leads (lead_number, name, email, created_by, estimated_value) values
      ('L-9001', 'Lead One', 'lead1@example.com', ${p1}, 50000),
      ('L-9002', 'Lead Two', 'lead2@example.com', ${p1}, 75000);
    insert into public.tds_statement_entries (financial_year, deductor_tan, tds_amount) values ('2026-27', 'BLRA12345B', 1000);

    insert into public.desktop_devices (id, device_key, device_name, last_user_id) values (${q(F.device)}, 'device-key-1', 'Front desk PC', ${p1});
    insert into public.desktop_device_numbers (device_id, number_id, linked_by)
      select ${q(F.device)}, n.id, ${p1} from public.firm_whatsapp_numbers n order by n.label limit 1;

    insert into public.audit_logs (id, event, user_id, user_email, user_role, action) values (${q(F.auditLog)}, 'login_success', ${p1}, 'p1@taxwise.test', 'partner', 'login');

    insert into public.notifications (user_id, type, title, body, link_url)
      select p.id, 'info', 'Hello ' || p.full_name, 'Fixture notification', '/inbox' from public.profiles p;

    insert into public.employee_leave (employee_id, start_date, end_date) values (${e("E1")}, '2026-11-02', '2026-11-03'), (${e("E2")}, '2026-11-05', '2026-11-05');
    insert into public.employee_sessions (employee_id, user_id) values (${e("E1")}, ${q(U.E1.id)}), (${e("E2")}, ${q(U.E2.id)});
    insert into public.attendance_records (employee_id, date, status) values (${e("E1")}, '2026-10-21', 'present'), (${e("E2")}, '2026-10-21', 'present');
    insert into public.employee_activities (employee_id, user_id, activity_type, description) values (${e("E1")}, ${q(U.E1.id)}, 'login', 'Signed in'), (${e("E2")}, ${q(U.E2.id)}, 'login', 'Signed in');
    insert into public.time_entries (employee_id, client_id, task_id, started_at, ended_at, minutes)
      values (${e("E1")}, ${q(C.A)}, ${q(F.task("A"))}, now() - interval '2 hours', now() - interval '1 hour', 60),
             (${e("E2")}, ${q(C.B)}, ${q(F.task("B"))}, now() - interval '2 hours', now() - interval '1 hour', 60);
    insert into public.independence_declarations (employee_id, financial_year) values (${e("E1")}, '2026-27'), (${e("E2")}, '2026-27');
    insert into public.holidays (date, name) values ('2026-11-01', 'Kannada Rajyotsava');

    insert into public.saved_views (user_id, page, name, is_shared) values (${p1}, 'work', 'P1 private', false), (${q(U.M1.id)}, 'work', 'M1 shared', true);
    insert into public.recent_searches (user_id, query) values (${p1}, 'alpha');
    insert into public.onboarding_drafts (user_id) values (${q(U.M1.id)});
    insert into public.job_runs (name) values ('fixture-job');
    insert into public.data_requests (subject, type) values ('Someone', 'access');
    insert into public.data_incidents (detected_at, description) values (now(), 'Fixture incident');
    insert into public.consent_records (subject_type, subject_id, notice_version) values ('portal_user', ${q(U.CA.id)}, 'v1');
    insert into public.tax_audit_external_counts (member_profile_id, financial_year, audits_signed_elsewhere) values (${p1}, '2026-27', 3);
    insert into public.peer_reviews (period_from, period_to, reviewer_name) values ('2024-04-01', '2027-03-31', 'Reviewer');
    insert into public.restore_drills (performed_on, outcome) values ('2026-10-01', 'passed');

    -- An expired client cover: E3 covered client A until yesterday (grants nothing now, §4.7).
    insert into public.client_covers (id, kind, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, reason, granted_by)
      values (${q(F.expiredCover)}, 'client', ${q(C.A)}, ${e("E1")}, ${e("E3")}, now() - interval '5 days', now() - interval '1 day', 'leave', ${p1});
  `;
}

/** The whole fixture script (run once per test database, as the superuser). */
export function fixtureSql(): string {
  return [
    "set search_path = public, extensions;",
    usersSql(),
    clientsSql(),
    perClientSql("A"),
    perClientSql("B"),
    perClientSql("C"),
    firmWideSql(),
  ].join("\n");
}
