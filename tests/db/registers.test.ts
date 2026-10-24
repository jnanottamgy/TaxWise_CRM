/**
 * Registers and engagement letters (§7.15.1–§7.15.3, §6.8, §4.1, §4.7): migrations 0191–0194.
 *   - the vault: who may reveal a stored password (Partners, Managers, Employees with Vault access
 *     for their own clients, covered clients only when the cover includes portal passwords), the
 *     reveal record (access log with IP + credential_viewed audit row, refused without the right),
 *     the register (no ciphertext, can_reveal, last view for Partners/Managers only), the trail;
 *   - UDINs: the ICAI ceiling guard (61st needs a Partner's confirmation by the person saving it;
 *     head office/branch once; revised and 3CB (c) don't count; audits signed elsewhere added),
 *     same-client links, the engagement's UDIN filled in, Employees only as the signing member,
 *     the membership number check;
 *   - registrations and DSCs: derived Expired, DIR-3 KYC Web every third FY by 30 June, RLS;
 *   - engagement letters: Draft → Issued → Signed / Declined / Expired, frozen once issued, same-
 *     client renewals, Partner signatory, the gaps list, nothing for Employees;
 *   - filing history: the import (transactional, re-runnable, validated, Partners/Managers), the
 *     view's origin and RLS, the facets.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { C, F, SQLSTATE, U, fid, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("registers");

/** A UDIN for membership number `member` (6 digits) with a distinct tail. */
function udin(n: number, member = "123456"): string {
  return `26${member}${String(n).padStart(10, "0")}`;
}

async function addUdin(s: Session, opts: { client: string | null; signer: string; n: number; form?: string; fy?: string; signedOn?: string; revised?: boolean; confirmedBy?: string | null; engagement?: string | null }) {
  return s.attempt<{ id: string }>(
    `insert into udin_records (client_id, udin, document_type, document_date, signed_on, generated_on, signing_partner_id, report_form, financial_year, is_revised, ceiling_confirmed_by, audit_engagement_id)
     values ($1, $2, 'Tax audit report', $3, $3, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [opts.client, udin(opts.n), opts.signedOn ?? "2026-10-01", opts.signer, opts.form ?? "3CA", opts.fy ?? "2025-26", opts.revised ?? false, opts.confirmedBy ?? null, opts.engagement ?? null],
  );
}

describe("the portal credentials vault (§7.15.1, §4.1, §4.7, §12)", () => {
  it("Partners and Managers may reveal any client's login; the reason is in plain words otherwise", async () => {
    for (const u of [U.P1, U.M1]) {
      const r = await db.asRole(u, (s) => s.value<{ allowed: boolean; client_id: string }>("select credential_reveal_check($1)", [F.credential("B")]));
      expect(r.allowed).toBe(true);
      expect(r.client_id).toBe(C.B);
    }
    // E1 has Vault access and owns A; B isn't theirs.
    expect((await db.asRole(U.E1, (s) => s.value<{ allowed: boolean }>("select credential_reveal_check($1)", [F.credential("A")]))).allowed).toBe(true);
    const notMine = await db.asRole(U.E1, (s) => s.value<{ allowed: boolean; reason: string }>("select credential_reveal_check($1)", [F.credential("B")]));
    expect(notMine.allowed).toBe(false);
    expect(notMine.reason).toMatch(/isn't for one of your clients/);
    // E2 is on B's team without Vault access.
    const noVault = await db.asRole(U.E2, (s) => s.value<{ allowed: boolean; reason: string }>("select credential_reveal_check($1)", [F.credential("B")]));
    expect(noVault.allowed).toBe(false);
    expect(noVault.reason).toMatch(/needs Vault access/);
    // A portal user never.
    expect((await db.asRole(U.CA, (s) => s.value<{ allowed: boolean }>("select credential_reveal_check($1)", [F.credential("A")]))).allowed).toBe(false);
  });

  it("a covered client counts only when the cover includes portal passwords and the cover person has Vault access (§4.7)", async () => {
    await db.asSuper(async (s) => {
      await s.exec(
        `insert into client_covers (id, kind, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, reason, granted_by, include_vault)
         values ($1, 'client', $2, $3, $4, now() - interval '1 hour', now() + interval '1 day', 'leave', $5, false)`,
        [fid("cover:vault"), C.A, U.E1.employeeId, U.E3.employeeId, U.P1.id],
      );
      await s.as(U.E3);
      const plain = await s.value<{ allowed: boolean; reason: string }>("select credential_reveal_check($1)", [F.credential("A")]);
      expect(plain.allowed).toBe(false);
      expect(plain.reason).toMatch(/needs Vault access/);

      await s.as("super");
      await s.exec("update employees set vault_access = true where id = $1", [U.E3.employeeId]);
      await s.as(U.E3);
      const noVaultCover = await s.value<{ allowed: boolean; reason: string }>("select credential_reveal_check($1)", [F.credential("A")]);
      expect(noVaultCover.allowed).toBe(false);
      expect(noVaultCover.reason).toMatch(/cover that doesn't include portal passwords/);
      expect(await s.value<boolean>("select can_reveal from client_credentials_register where id = $1", [F.credential("A")])).toBe(false);

      await s.as("super");
      await s.exec("update client_covers set include_vault = true where id = $1", [fid("cover:vault")]);
      await s.as(U.E3);
      const viaCover = await s.value<{ allowed: boolean; via_cover: boolean }>("select credential_reveal_check($1)", [F.credential("A")]);
      expect(viaCover).toMatchObject({ allowed: true, via_cover: true });
      expect(await s.value<boolean>("select can_reveal from client_credentials_register where id = $1", [F.credential("A")])).toBe(true);

      // Once the cover ends, nothing.
      await s.as("super");
      await s.exec("update client_covers set ends_at = now() - interval '1 minute', starts_at = now() - interval '2 hours' where id = $1", [fid("cover:vault")]);
      await s.as(U.E3);
      expect((await s.value<{ allowed: boolean }>("select credential_reveal_check($1)", [F.credential("A")])).allowed).toBe(false);
    });
  });

  it("record_credential_reveal writes the access log with the IP and the credential_viewed audit row, or refuses", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await s.value<{ access_log_id: string; audit_id: string }>("select record_credential_reveal($1, '203.0.113.7', 'vitest')", [F.credential("A")]);
      await s.as("super");
      const log = await s.one<{ user_id: string; action: string; ip: string }>("select user_id, action, ip from credential_access_logs where id = $1", [r.access_log_id]);
      expect(log).toEqual({ user_id: U.E1.id, action: "viewed", ip: "203.0.113.7" });
      const audit = await s.one<{ event: string; user_id: string; resource_id: string; ip: string; details: Record<string, unknown> }>(
        "select event::text, user_id, resource_id, ip, details from audit_logs where id = $1",
        [r.audit_id],
      );
      expect(audit).toMatchObject({ event: "credential_viewed", user_id: U.E1.id, resource_id: F.credential("A"), ip: "203.0.113.7" });
      expect(audit.details).toMatchObject({ client_id: C.A, portal: "GST", username: "user_A" });
      expect(JSON.stringify(audit.details)).not.toMatch(/cipher/);

      await s.as(U.E1);
      const refused = await s.fails("select record_credential_reveal($1, null, null)", [F.credential("B")]);
      expect(refused.code).toBe(SQLSTATE.raiseException);
      expect(userMessage(refused)).toMatch(/isn't for one of your clients/);
    });
    await db.asRole(U.E2, async (s) => {
      expect(userMessage(await s.fails("select record_credential_reveal($1, null, null)", [F.credential("B")]))).toMatch(/needs Vault access/);
    });
  });

  it("the register never has the ciphertext; Employees see their clients' logins but not who viewed them", async () => {
    await db.asRole(U.P1, async (s) => {
      expect((await s.fails("select password_ciphertext from client_credentials_register")).message).toMatch(/does not exist/);
      const rows = await s.rows<{ client_name: string; can_reveal: boolean; view_count: number | null }>("select client_name, can_reveal, view_count from client_credentials_register order by client_name");
      expect(rows.map((r) => r.client_name)).toEqual(["Alpha Traders", "Beta Industries", "Gamma LLP"]);
      expect(rows.every((r) => r.can_reveal && r.view_count === 0)).toBe(true);
    });
    await db.asRole(U.E1, async (s) => {
      expect(await s.rows("select id, can_reveal, last_viewed_at, view_count from client_credentials_register")).toEqual([
        { id: F.credential("A"), can_reveal: true, last_viewed_at: null, view_count: null },
      ]);
    });
    await db.asRole(U.E2, async (s) => {
      expect(await s.rows("select id, can_reveal from client_credentials_register")).toEqual([{ id: F.credential("B"), can_reveal: false }]);
    });
    expect(await db.asRole(U.CA, (s) => s.value<number>("select count(*)::int from client_credentials_register"))).toBe(0);
    // Views are read-only for API roles.
    const privileges = await db.asSuper((s) =>
      s.rows<{ v: string; p: string }>(
        `select v, p from unnest(array['client_credentials_register', 'credential_access_trail', 'udin_register', 'statutory_registrations_register', 'dsc_register', 'engagement_letters_register', 'filing_history']) v,
           unnest(array['INSERT', 'UPDATE', 'DELETE']) p
         where has_table_privilege('authenticated', 'public.' || v, p) or has_table_privilege('anon', 'public.' || v, 'SELECT')`,
      ),
    );
    expect(privileges).toEqual([]);
  });

  it("the access trail is for Partners and Managers, with names", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.value("select record_credential_reveal($1, '198.51.100.1', null)", [F.credential("C")]);
      const trail = await s.rows<{ action: string; user_name: string; ip: string | null }>(
        "select action, user_name, ip from credential_access_trail where credential_id = $1 order by created_at",
        [F.credential("C")],
      );
      expect(trail).toEqual([
        { action: "created", user_name: "Test P1", ip: null },
        { action: "viewed", user_name: "Test P1", ip: "198.51.100.1" },
      ]);
    });
    expect(await db.asRole(U.E1, (s) => s.value<number>("select count(*)::int from credential_access_trail"))).toBe(0);
  });

  it("no new function hands the ciphertext to an API role", async () => {
    const leaks = await db.asSuper((s) =>
      s.rows(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
           and p.prosrc ilike '%password_ciphertext%' and p.proname not in ('save_client_credential')`,
      ),
    );
    expect(leaks).toEqual([]);
  });
});

describe("UDINs and the tax-audit ceiling (§6.8, §7.15.1, §18.3 Partner 7)", () => {
  async function setElsewhere(s: Session, member: string, n: number) {
    await s.as("super");
    await s.exec(
      `insert into tax_audit_external_counts (member_profile_id, financial_year, audits_signed_elsewhere) values ($1, '2026-27', $2)
       on conflict (member_profile_id, financial_year) do update set audits_signed_elsewhere = excluded.audits_signed_elsewhere`,
      [member, n],
    );
  }

  it("the 60th is logged; the 61st needs a Partner's confirmation, given by the person saving it", async () => {
    await db.asSuper(async (s) => {
      await setElsewhere(s, U.P2.id, 59);
      await s.as(U.P2);
      expect((await addUdin(s, { client: C.A, signer: U.P2.id, n: 1 })).ok).toBe(true);
      expect(await s.value("select tax_audit_position($1, '2026-27')", [U.P2.id])).toMatchObject({ counted: 60, in_firm: 1, elsewhere: 59, ceiling: 60 });

      const over = await addUdin(s, { client: C.B, signer: U.P2.id, n: 2 });
      expect(over.ok).toBe(false);
      if (!over.ok) expect(userMessage(over)).toMatch(/tax audit 61 for Test P2 in FY 2026-27, over the ICAI ceiling of 60\. A Partner must confirm it/);

      // A Manager can't confirm, and can't confirm in a Partner's name.
      await s.as(U.M1);
      for (const by of [U.M1.id, U.P2.id]) {
        const r = await addUdin(s, { client: C.B, signer: U.P2.id, n: 2, confirmedBy: by });
        expect(r.ok).toBe(false);
      }
      // Any Partner confirming as themselves can.
      await s.as(U.P1);
      const ok = await addUdin(s, { client: C.B, signer: U.P2.id, n: 2, confirmedBy: U.P1.id });
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const row = await s.one<{ ceiling_confirmed_by: string; confirmed: boolean }>("select ceiling_confirmed_by, ceiling_confirmed_at is not null as confirmed from udin_records where id = $1", [ok.rows[0].id]);
        expect(row).toEqual({ ceiling_confirmed_by: U.P1.id, confirmed: true });
      }
    });
  });

  it("applies the counting rules: head office and branch once, revised and 3CB (c) never, other FYs apart", async () => {
    await db.asSuper(async (s) => {
      await setElsewhere(s, U.P2.id, 59);
      await s.as(U.P2);
      expect((await addUdin(s, { client: C.A, signer: U.P2.id, n: 11 })).ok).toBe(true); // 60
      // A branch report of the same assessee and year: still 60.
      expect((await addUdin(s, { client: C.A, signer: U.P2.id, n: 12 })).ok).toBe(true);
      // A revised report and a 3CB u/s 44AB(c) don't count.
      expect((await addUdin(s, { client: C.B, signer: U.P2.id, n: 13, revised: true })).ok).toBe(true);
      expect((await addUdin(s, { client: C.C, signer: U.P2.id, n: 14, form: "3CB_44AB_c" })).ok).toBe(true);
      // Signed in another FY: counted there, not here.
      expect((await addUdin(s, { client: C.B, signer: U.P2.id, n: 15, signedOn: "2026-03-20", fy: "2024-25" })).ok).toBe(true);
      expect(await s.value("select tax_audit_position($1, '2026-27')", [U.P2.id])).toMatchObject({ counted: 60, in_firm: 1 });
      // The view agrees.
      expect(await s.one("select total_count, warning from tax_audit_ceiling_view where member_profile_id = $1 and financial_year = '2026-27'", [U.P2.id])).toEqual({
        total_count: 60,
        warning: "at_ceiling",
      });
      // Form 26 by its category: (c) doesn't count.
      expect(
        (
          await s.attempt(
            `insert into udin_records (client_id, udin, document_type, document_date, signed_on, generated_on, signing_partner_id, report_form, form26_category, counts_towards_tax_audit_ceiling, financial_year)
             values ($1, $2, 'Tax audit report', '2026-10-02', '2026-10-02', '2026-10-02', $3, 'FORM_26', 'c', false, '2026-27')`,
            [C.C, udin(16), U.P2.id],
          )
        ).ok,
      ).toBe(true);
    });
  });

  it("an Employee logs a UDIN only as its signing member, for their own client, and sees only their own count", async () => {
    await db.asRole(U.E1, async (s) => {
      // Signing staff carry an ICAI membership number (0230; without one the insert is refused).
      await s.as("super");
      await s.exec("update profiles set icai_membership_no = '123456' where id = $1", [U.E1.id]);
      await s.as(U.E1);
      expect((await addUdin(s, { client: C.A, signer: U.E1.id, n: 21 })).ok).toBe(true);
      const asPartner = await addUdin(s, { client: C.A, signer: U.P1.id, n: 22 });
      expect(asPartner.ok).toBe(false);
      const otherClient = await addUdin(s, { client: C.B, signer: U.E1.id, n: 23 });
      expect(otherClient.ok).toBe(false);
      expect(userMessage(await s.fails("select tax_audit_position($1, '2026-27')", [U.P1.id]))).toMatch(/only your own/);
      expect(await s.value("select tax_audit_position($1, '2026-27')", [U.E1.id])).toMatchObject({ counted: 1 });
      // Updating is for Partners and Managers.
      expect(await s.exec("update udin_records set remarks = 'x' where signing_partner_id = $1", [U.E1.id])).toBe(0);
    });
  });

  it("links point at the UDIN's own client, and a linked engagement gets its UDIN", async () => {
    await db.asRole(U.P1, async (s) => {
      const engA = await s.value<string>("select id from audit_engagements where client_id = $1", [C.A]);
      const engB = await s.value<string>("select id from audit_engagements where client_id = $1", [C.B]);
      const foreign = await addUdin(s, { client: C.A, signer: U.P1.id, n: 31, engagement: engB });
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(userMessage(foreign)).toMatch(/belongs to another client/);
      const linked = await addUdin(s, { client: C.A, signer: U.P1.id, n: 32, engagement: engA });
      expect(linked.ok).toBe(true);
      if (linked.ok) expect(await s.value("select udin_record_id from audit_engagements where id = $1", [engA])).toBe(linked.rows[0].id);
      const filingB = await s.value<string>("select id from filing_records where client_id = $1 limit 1", [C.B]);
      expect(
        userMessage(
          await s.fails(
            `insert into udin_records (client_id, udin, document_type, document_date, signed_on, generated_on, signing_partner_id, report_form, filing_record_id)
             values ($1, $2, 'Certificate', '2026-10-01', '2026-10-01', '2026-10-01', $3, 'certificate', $4)`,
            [C.A, udin(33), U.P1.id, filingB],
          ),
        ),
      ).toMatch(/filing record belongs to another client/);
    });
  });

  it("the register checks the membership number and the 60 days, under RLS", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update profiles set icai_membership_no = '123456' where id = $1", [U.P1.id]);
      await s.as(U.P1);
      expect(await s.value("select bool_and(not membership_mismatch) from udin_register where signing_partner_id = $1", [U.P1.id])).toBe(true);
      await s.as("super");
      await s.exec("update profiles set icai_membership_no = '654321' where id = $1", [U.P1.id]);
      await s.exec(
        `insert into udin_records (client_id, udin, document_type, document_date, signed_on, generated_on, signing_partner_id, report_form)
         values ($1, $2, 'Certificate', '2026-06-01', '2026-06-01', '2026-08-15', $3, 'certificate')`,
        [C.A, udin(41), U.P1.id],
      );
      await s.as(U.P1);
      const row = await s.one<{ membership_mismatch: boolean; days_to_generate: number; generated_late: boolean }>(
        "select membership_mismatch, days_to_generate, generated_late from udin_register where udin = $1",
        [udin(41)],
      );
      expect(row).toEqual({ membership_mismatch: true, days_to_generate: 75, generated_late: true });
      await s.as(U.E1);
      expect((await s.rows<{ client_id: string }>("select distinct client_id from udin_register")).map((r) => r.client_id)).toEqual([C.A]);
    });
  });
});

describe("statutory registrations and DSCs (§7.15.1, §6.7)", () => {
  it("derives Expired past the date, the reminder window and the next DIR-3 KYC Web for a DIN", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.exec(
        `insert into statutory_registrations (id, client_id, registration_type, registration_number, expiry_date, reminder_days, last_dir3_kyc_fy) values
           ($1, $2, 'FSSAI', '10012345000123', current_date - 3, 30, null),
           ($3, $2, 'IEC', 'AAKCS1234C', current_date + 10, 30, null),
           ($4, $2, 'DIN', '01234567', null, 30, '2025-26')`,
        [fid("reg:fssai"), C.A, fid("reg:iec"), fid("reg:din")],
      );
      const rows = await s.rows<{ id: string; display_status: string; in_reminder_window: boolean; next_dir3_kyc_fy: string | null; next_dir3_kyc_due: Date | null }>(
        "select id, display_status, in_reminder_window, next_dir3_kyc_fy, next_dir3_kyc_due from statutory_registrations_register where id = any($1) order by registration_type",
        [[fid("reg:fssai"), fid("reg:iec"), fid("reg:din")]],
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[fid("reg:fssai")]).toMatchObject({ display_status: "expired", in_reminder_window: false });
      expect(byId[fid("reg:iec")]).toMatchObject({ display_status: "active", in_reminder_window: true });
      expect(byId[fid("reg:din")].next_dir3_kyc_fy).toBe("2028-29");
      expect(await s.value("select (dir3_kyc_next_due('2025-26') ->> 'due')")).toBe("2028-06-30");
    });
  });

  it("Employees read their own clients' registrations and DSCs and change none", async () => {
    await db.asRole(U.E1, async (s) => {
      expect((await s.rows<{ client_id: string }>("select distinct client_id from statutory_registrations_register")).map((r) => r.client_id)).toEqual([C.A]);
      expect((await s.rows<{ client_id: string }>("select distinct client_id from dsc_register")).map((r) => r.client_id)).toEqual([C.A]);
      const ins = await s.attempt("insert into dsc_records (client_id, holder_name, expiry_date) values ($1, 'X', '2027-01-01')", [C.A]);
      expect(ins.ok).toBe(false);
      expect(await s.exec("update statutory_registrations set notes = 'x' where client_id = $1", [C.A])).toBe(0);
    });
    await db.asRole(U.M1, async (s) => {
      await s.exec("update dsc_records set expiry_date = current_date - 1 where client_id = $1", [C.B]);
      expect(await s.value("select display_status from dsc_register where client_id = $1", [C.B])).toBe("expired");
    });
  });
});

describe("engagement letters (§7.15.3, §4.1)", () => {
  async function newLetter(s: Session, client = C.A, fy = "2027-28") {
    return s.value<string>(
      `insert into engagement_letters (client_id, financial_year, service_types, scope, fee_agreed, services_schedule, signatory_id)
       values ($1, $2, '{gst,income_tax}', 'GST returns and ITR', 72000, '[{"service_type":"gst","description":"GST returns","frequency":"monthly","fee":"5000.00"}]', $3) returning id`,
      [client, fy, U.P1.id],
    );
  }

  it("starts as a draft and moves Draft → Issued → Signed, stamping the dates", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(
        userMessage(
          await s.fails("insert into engagement_letters (client_id, financial_year, service_types, status) values ($1, '2027-28', '{gst}', 'issued')", [C.A]),
        ),
      ).toMatch(/starts as a draft/);
      const id = await newLetter(s);
      expect(await s.value("select created_by from engagement_letters where id = $1", [id])).toBe(U.M1.id);
      expect(userMessage(await s.fails("update engagement_letters set status = 'signed' where id = $1", [id]))).toMatch(/can't go from Draft to Signed/);
      await s.exec("update engagement_letters set status = 'issued' where id = $1", [id]);
      expect(await s.value("select issued_at is not null from engagement_letters where id = $1", [id])).toBe(true);
      expect(userMessage(await s.fails("update engagement_letters set fee_agreed = 1 where id = $1", [id]))).toMatch(/issued letter can't be changed/);
      expect(userMessage(await s.fails("update engagement_letters set signed_at = now() + interval '3 days', status = 'signed' where id = $1", [id]))).toMatch(/can't be in the future/);
      await s.exec("update engagement_letters set status = 'signed', notes = 'Signed by the director' where id = $1", [id]);
      expect(await s.value("select signed_at is not null from engagement_letters where id = $1", [id])).toBe(true);
      await s.exec("update engagement_letters set status = 'expired' where id = $1", [id]);
      expect(userMessage(await s.fails("update engagement_letters set status = 'issued' where id = $1", [id]))).toMatch(/can't go from Expired to Issued/);
    });
  });

  it("a decline needs the reason; a declined or withdrawn letter goes back to Draft and can be edited", async () => {
    await db.asRole(U.P1, async (s) => {
      const id = await newLetter(s);
      await s.exec("update engagement_letters set status = 'issued' where id = $1", [id]);
      expect(userMessage(await s.fails("update engagement_letters set status = 'declined' where id = $1", [id]))).toMatch(/Say why/);
      await s.exec("update engagement_letters set status = 'declined', declined_reason = 'Fee too high' where id = $1", [id]);
      await s.exec("update engagement_letters set status = 'draft' where id = $1", [id]);
      await s.exec("update engagement_letters set fee_agreed = 60000 where id = $1", [id]);
      expect(await s.one("select status::text, issued_at, fee_agreed::text from engagement_letters where id = $1", [id])).toEqual({ status: "draft", issued_at: null, fee_agreed: "60000.00" });
      expect(userMessage(await s.fails("update engagement_letters set client_id = $2 where id = $1", [id, C.B]))).toMatch(/stays with its client/);
    });
  });

  it("checks renewals, audit engagements and the signatory against the letter's client", async () => {
    await db.asRole(U.P1, async (s) => {
      const a = await newLetter(s, C.A);
      expect(
        userMessage(await s.fails("insert into engagement_letters (client_id, financial_year, service_types, renewed_from_id) values ($1, '2028-29', '{gst}', $2)", [C.B, a])),
      ).toMatch(/same client/);
      expect(
        userMessage(await s.fails("insert into engagement_letters (client_id, financial_year, service_types, signatory_id) values ($1, '2028-29', '{gst}', $2)", [C.A, U.M1.id])),
      ).toMatch(/active Partner/);
      const engB = await s.value<string>("select id from audit_engagements where client_id = $1", [C.B]);
      expect(
        userMessage(
          await s.fails("insert into engagement_letters (client_id, financial_year, service_types, audit_engagement_id) values ($1, '2025-26', '{audit}', $2)", [C.A, engB]),
        ),
      ).toMatch(/another client/);
      const renewal = await s.value<string>("insert into engagement_letters (client_id, financial_year, service_types, renewed_from_id) values ($1, '2028-29', '{gst}', $2) returning id", [C.A, a]);
      expect(await s.one("select renewal_id, renewal_fy from engagement_letters_register where id = $1", [a])).toEqual({ renewal_id: renewal, renewal_fy: "2028-29" });
    });
  });

  it("the register derives Expired and the gaps list shows clients with services and no letter Issued or Signed", async () => {
    await db.asRole(U.M1, async (s) => {
      // The fixture letters are drafts for 2026-27, so every active client with a service is missing one.
      expect((await s.rows<{ client_id: string }>("select client_id from engagement_letter_gaps('2026-27') order by client_name")).map((r) => r.client_id)).toEqual([C.A, C.B, C.C]);
      const gapA = await s.one<{ drafts: number; service_types: string }>("select drafts, service_types::text from engagement_letter_gaps('2026-27') where client_id = $1", [C.A]);
      expect(gapA).toEqual({ drafts: 1, service_types: "{gst}" });
      await s.exec("update engagement_letters set status = 'issued', expires_at = current_date - 1 where client_id = $1 and financial_year = '2026-27'", [C.A]);
      expect((await s.rows<{ client_id: string }>("select client_id from engagement_letter_gaps('2026-27')")).map((r) => r.client_id).sort()).toEqual([C.B, C.C].sort());
      expect(await s.value("select display_status from engagement_letters_register where client_id = $1 and financial_year = '2026-27'", [C.A])).toBe("expired");
    });
  });

  it("Employees get nothing: no letters, no gaps", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.value<number>("select count(*)::int from engagement_letters_register")).toBe(0);
      expect(await s.value<number>("select count(*)::int from engagement_letter_gaps('2026-27')")).toBe(0);
      const ins = await s.attempt("insert into engagement_letters (client_id, financial_year, service_types) values ($1, '2027-28', '{gst}')", [C.A]);
      expect(ins.ok).toBe(false);
    });
  });
});

describe("filing history (§7.15.2)", () => {
  const rows = [
    { financial_year: "2024-25", filing_type: "GSTR-3B", period: "Mar 2025", filed_on: "2025-04-18", acknowledgement_no: "AA290325123456Z", filed_by_external: "Rao & Co", service_type: "gst" },
    { financial_year: "2024-25", filing_type: "ITR-3", period: null, filed_on: "2025-07-30", acknowledgement_no: "123456789012345", filed_by_external: "Rao & Co", service_type: "income_tax" },
  ];

  it("imports a client's prior filings in one go, and a second run skips what is already there", async () => {
    await db.asRole(U.M1, async (s) => {
      const first = await s.value<{ inserted: number; skipped: number; ids: string[] }>("select import_filing_records($1, $2::jsonb)", [C.A, JSON.stringify(rows)]);
      expect(first).toMatchObject({ inserted: 2, skipped: 0 });
      const again = await s.value<{ inserted: number; skipped: number }>("select import_filing_records($1, $2::jsonb)", [C.A, JSON.stringify(rows)]);
      expect(again).toMatchObject({ inserted: 0, skipped: 2 });
      const listed = await s.rows<{ origin: string; filed_by_external: string; created_by_name: string }>(
        "select origin, filed_by_external, created_by_name from filing_history where id = any($1)",
        [first.ids],
      );
      expect(listed).toEqual([
        { origin: "inherited", filed_by_external: "Rao & Co", created_by_name: "Test M1" },
        { origin: "inherited", filed_by_external: "Rao & Co", created_by_name: "Test M1" },
      ]);
      const facets = await s.value<{ forms: string[]; years: string[] }>("select filing_history_facets($1)", [C.A]);
      expect(facets.forms).toEqual(expect.arrayContaining(["GSTR-1", "GSTR-3B", "ITR-3"]));
      expect(facets.years).toEqual(["2026-27", "2024-25"]);
    });
  });

  it("refuses a bad row with its number, and the whole import with it", async () => {
    await db.asRole(U.P1, async (s) => {
      const bad = [...rows, { financial_year: "2024/25", filing_type: "GSTR-1", filed_by_external: "Rao & Co" }];
      expect(userMessage(await s.fails("select import_filing_records($1, $2::jsonb)", [C.B, JSON.stringify(bad)]))).toMatch(/Row 3: the FY should look like 2024-25/);
      const noFirm = [{ financial_year: "2024-25", filing_type: "GSTR-1" }];
      expect(userMessage(await s.fails("select import_filing_records($1, $2::jsonb)", [C.B, JSON.stringify(noFirm)]))).toMatch(/Row 1: enter the previous firm/);
      expect(await s.value<number>("select count(*)::int from filing_records where client_id = $1 and filed_by_external is not null", [C.B])).toBe(0);
    });
  });

  it("Employees read their own clients' history and can't import", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select import_filing_records($1, $2::jsonb)", [C.A, JSON.stringify(rows)]))).toMatch(/Only Partners and Managers/);
      expect((await s.rows<{ client_id: string }>("select distinct client_id from filing_history")).map((r) => r.client_id)).toEqual([C.A]);
      expect(await s.value("select origin from filing_history limit 1")).toBe("ours");
    });
    expect(await db.asRole(U.CA, (s) => s.value<number>("select count(*)::int from filing_history"))).toBe(0);
  });
});
