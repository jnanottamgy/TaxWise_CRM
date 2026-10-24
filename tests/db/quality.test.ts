/**
 * Quality & risk, audit engagements and DPDP (§6.8, §6.9, §6.10, §7.15.4, §7.15.5, §18.3 Partner 3):
 * migrations 0195–0199.
 *   - audit engagements: created at Acceptance with an empty checklist; stage, checklist, archive
 *     and the ceiling confirmation only through the functions; the engagement partner is a Partner;
 *   - the Acceptance gate: KYC complete for the category and current, an accepted conflict check, an
 *     SA 210 letter at Issued, the previous-auditor answer and the letter with proof of delivery
 *     (§18.3 Partner 3: KYC and the previous-auditor step block the engagement until completed), the
 *     peer review certificate, the ceilings; the engagement partner approves every move;
 *   - sign-offs: evidence before prepare, nobody reviews their own work, current stage only;
 *   - materiality before leaving Planning; report, UDIN and CARO before archive;
 *   - archive locks the engagement and its documents (versions and tags too); later additions are
 *     amendments with a note; retention extended to report date + 7 years;
 *   - the company audit limit and the tax audit ceiling with a Partner's confirmation;
 *   - parity: step definitions, KYC completeness, small company, seeded parameters vs lib/domain;
 *   - DPDP: due dates, closing rules, Partner-only writes, notice publishing, breach checklist;
 *   - quality: independence declarations, peer reviews, restore drills;
 *   - Employees and portal users see none of it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { C, F, U, setupTestDatabase, userMessage, visibleCount, type Session } from "./helpers";
import { AUDIT_SEED_PARAMETERS, AUDIT_STEPS, countsTowardsCompanyLimit, isSmallCompany, readCompanyFacts, resolveAuditParams } from "@/lib/domain/audit-stages";
import { DPDP_SEED_PARAMETERS } from "@/lib/domain/dpdp";
import { kycCompleteness } from "@/lib/domain/ceiling";
import { addDays, todayIST } from "@/lib/domain/fy";

const db = setupTestDatabase("quality");

const P1E = U.P1.employeeId!;
const P2E = U.P2.employeeId!;
const M1E = U.M1.employeeId!;

async function newEngagement(s: Session, opts: { client?: string; type?: string; fy?: string; partner?: string; profile?: Record<string, unknown> | null } = {}): Promise<string> {
  return s.value<string>(
    `insert into audit_engagements (client_id, audit_type, financial_year, engagement_partner_id, company_profile)
     values ($1, $2, $3, $4, $5) returning id`,
    [opts.client ?? C.A, opts.type ?? "tax_audit", opts.fy ?? "2025-26", opts.partner ?? P1E, opts.profile ? JSON.stringify(opts.profile) : null],
  );
}

async function gate(s: Session, id: string, to: string) {
  return s.value<{ ok: boolean; missing: Array<{ code: string; message: string; step?: string }>; warnings: Array<{ code: string }>; is_engagement_partner: boolean }>(
    "select audit_stage_gate($1, $2)",
    [id, to],
  );
}

async function sign(s: Session, id: string, step: string, action: string, note: string | null = null) {
  return s.attempt("select audit_step_signoff($1, $2, $3, $4)", [id, step, action, note]);
}

/** Prepares (or marks N/A) as P1 and reviews as M1 every step of a stage, attaching evidence where needed. */
async function signStage(s: Session, id: string, stage: string, auditType: string, doc: string) {
  const steps = AUDIT_STEPS.filter((x) => x.stage === stage && (!x.auditTypes || x.auditTypes.includes(auditType as never)));
  for (const step of steps) {
    await s.as(U.P1);
    const reviewed = await s.value<boolean>("select audit_step_done(checklist, $2) from audit_engagements where id = $1", [id, step.key]);
    if (reviewed) continue;
    if (step.evidenceRequired) await s.exec("select audit_attach_evidence($1, $2, $3::uuid[], null)", [id, step.key, [doc]]);
    const p = await sign(s, id, step.key, "prepare");
    if (!p.ok) throw new Error(`prepare ${step.key}: ${p.message}`);
    await s.as(U.M1);
    const r = await sign(s, id, step.key, "review");
    if (!r.ok) throw new Error(`review ${step.key}: ${r.message}`);
  }
  await s.as(U.P1);
}

/** Everything the Acceptance gate needs for client A, set up as the superuser. */
async function satisfyAcceptanceFacts(s: Session, engagementId: string, opts: { letterFy?: string } = {}) {
  const today = todayIST();
  await s.as("super");
  await s.exec(
    `update client_kyc set pan = 'AAACA1234A', cin_llpin = 'U74999KA2020PTC123456', business_description = 'Trading in steel',
       last_audited_fs_document_id = $2, engagement_types = '{tax_audit}',
       principal_persons = '[{"name":"Asha Rao","address":"Bengaluru","din":"01234567"}]'::jsonb,
       verified_on = $3, next_review_on = $4
     where client_id = $1`,
    [C.A, F.docPrivate("A"), today, addDays(today, 300)],
  );
  await s.exec("insert into client_acceptances (prospect_name, client_id, outcome, decided_at, decided_by, conflicts_found, created_by) values ('A', $1, 'accepted', now(), $2, '[]'::jsonb, $2)", [C.A, U.P1.id]);
  await s.exec(
    "insert into engagement_letters (client_id, financial_year, service_types, status, issued_at, audit_type) values ($1, $2, '{audit}', 'issued', now(), 'tax_audit')",
    [C.A, opts.letterFy ?? "2025-26"],
  );
  await s.as(U.P1);
  await s.exec("update audit_engagements set had_previous_auditor = false where id = $1", [engagementId]);
}

describe("audit engagements: creation and the guard (§6.9, §7.15.5)", () => {
  it("starts at Acceptance with an empty checklist; stage and checklist can't be written directly", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await s.value<string>(
        `insert into audit_engagements (client_id, audit_type, financial_year, engagement_partner_id, stage, checklist)
         values ($1, 'tax_audit', '2025-26', $2, 'reporting', '{"steps":{"acc.kyc":{"prepared_at":"x","reviewed_at":"y"}}}') returning id`,
        [C.A, P1E],
      );
      const row = await s.one<{ stage: string; checklist: unknown; created_by: string }>("select stage, checklist, created_by from audit_engagements where id = $1", [id]);
      expect(row.stage).toBe("acceptance");
      expect(row.checklist).toEqual({});
      expect(row.created_by).toBe(U.M1.id);
      expect(userMessage(await s.fails("update audit_engagements set stage = 'planning' where id = $1", [id]))).toMatch(/stage tracker/);
      expect(userMessage(await s.fails("update audit_engagements set checklist = '{\"steps\":{}}' where id = $1", [id]))).toMatch(/one at a time/);
      expect(userMessage(await s.fails("update audit_engagements set limit_override_at = now(), limit_override_by = $2, limit_override_note = 'x' where id = $1", [id, U.M1.id]))).toMatch(/Partner/);
      // A Manager can't be the engagement partner, and only a Partner changes it.
      expect(userMessage(await s.fails("insert into audit_engagements (client_id, audit_type, financial_year, engagement_partner_id) values ($1, 'tax_audit', '2025-26', $2)", [C.A, M1E]))).toMatch(/active Partner/);
      expect(userMessage(await s.fails("update audit_engagements set engagement_partner_id = $2 where id = $1", [id, P2E]))).toMatch(/Only a Partner/);
    });
  });

  it("Employees and portal users see no audit engagement, step, evidence or log, and can't call the functions", async () => {
    for (const u of [U.E1, U.E2, U.CA]) {
      await db.asRole(u, async (s) => {
        for (const t of ["audit_engagements", "audit_engagements_list", "audit_engagement_documents", "audit_engagement_stage_log", "audit_step_definitions", "previous_auditor_communications"]) {
          expect(visibleCount(await s.attempt(`select 1 from ${t}`))).toBe(0);
        }
        const g = await s.attempt("select audit_stage_gate(gen_random_uuid(), 'planning')");
        expect(g.ok).toBe(false);
        const sg = await s.attempt("select audit_step_signoff(gen_random_uuid(), 'acc.kyc', 'prepare', null)");
        expect(sg.ok).toBe(false);
      });
    }
  });
});

describe("the Acceptance gate (§6.8, §6.9, §18.3 Partner 3)", () => {
  it("KYC, the conflict check, the SA 210 letter and the previous-auditor step block the move until done", async () => {
    await db.asRole(U.P1, async (s) => {
      const id = await newEngagement(s);
      let g = await gate(s, id, "planning");
      expect(g.ok).toBe(false);
      expect(g.is_engagement_partner).toBe(true);
      const codes = g.missing.map((m) => m.code);
      expect(codes).toEqual(expect.arrayContaining(["kyc", "acceptance", "engagement_letter", "previous_auditor_unanswered", "step"]));
      expect(g.missing.find((m) => m.code === "kyc")!.message).toMatch(/PAN/);
      // Refused with the plain sentence.
      expect(userMessage(await s.fails("select advance_audit_stage($1, 'planning', null, null)", [id]))).toMatch(/^Before Planning: .*KYC/);

      await satisfyAcceptanceFacts(s, id);
      // There was a previous auditor: now the letter with proof of delivery is needed.
      await s.exec("update audit_engagements set had_previous_auditor = true where id = $1", [id]);
      g = await gate(s, id, "planning");
      expect(g.missing.map((m) => m.code)).toContain("previous_auditor");
      expect(g.missing.map((m) => m.code)).not.toContain("kyc");
      const comm = await s.value<string>(
        "insert into previous_auditor_communications (client_id, engagement_type, previous_auditor_name, letter_sent_on, audit_engagement_id) values ($1, 'tax_audit', 'R Iyer & Co', current_date - 10, $2) returning id",
        [C.A, id],
      );
      expect((await gate(s, id, "planning")).missing.map((m) => m.code)).toContain("previous_auditor");
      // Proof of delivery must be one of the client's documents.
      expect(userMessage(await s.fails("update previous_auditor_communications set delivery_proof_document_id = $2 where id = $1", [comm, F.docPrivate("B")]))).toMatch(/this client/);
      await s.exec("update previous_auditor_communications set delivery_proof_document_id = $2 where id = $1", [comm, F.docShared("A")]);
      expect((await gate(s, id, "planning")).missing.map((m) => m.code)).not.toContain("previous_auditor");

      // Peer review where the entity needs a peer-reviewed auditor.
      await s.exec("update audit_engagements set requires_peer_reviewed_auditor = true where id = $1", [id]);
      expect((await gate(s, id, "planning")).missing.map((m) => m.code)).toContain("peer_review");
      await s.exec("insert into peer_reviews (period_from, period_to, reviewer_name, status, reviewed_on, certificate_no, valid_until) values ('2023-04-01', '2026-03-31', 'CA Reviewer', 'completed', current_date - 100, 'PR/2026/77', current_date + 400)");
      expect((await gate(s, id, "planning")).missing.map((m) => m.code)).not.toContain("peer_review");

      // Only the checklist is left.
      g = await gate(s, id, "planning");
      expect(new Set(g.missing.map((m) => m.code))).toEqual(new Set(["step"]));
      await signStage(s, id, "acceptance", "tax_audit", F.docPrivate("A"));
      g = await gate(s, id, "planning");
      expect(g.ok).toBe(true);

      // The engagement partner approves; a Manager can't.
      await s.as(U.M1);
      expect(userMessage(await s.fails("select advance_audit_stage($1, 'planning', null, null)", [id]))).toMatch(/Only Test P1, the engagement partner/);
      await s.as(U.P1);
      const before = await s.value<string>("select updated_at::text from audit_engagements where id = $1", [id]);
      const moved = await s.value<{ stage: string }>("select advance_audit_stage($1, 'planning', null, $2::timestamptz)", [id, before]);
      expect(moved.stage).toBe("planning");
      const row = await s.one<{ accepted_on: string | null; stage: string }>("select accepted_on::text, stage from audit_engagements where id = $1", [id]);
      expect(row.accepted_on).toBe(todayIST());
      expect(await s.value<number>("select count(*)::int from audit_engagement_stage_log where engagement_id = $1 and to_stage = 'planning' and approved_by = $2", [id, U.P1.id])).toBe(1);
      // A stale form is refused with who changed it.
      expect(userMessage(await s.fails("select advance_audit_stage($1, 'risk_assessment', null, '2020-01-01T00:00:00Z'::timestamptz)", [id]))).toMatch(/^Changed by Test P1 at/);
      // Acceptance answers are fixed now.
      expect(userMessage(await s.fails("update audit_engagements set had_previous_auditor = false where id = $1", [id]))).toMatch(/fixed once/);
    });
  });

  it("a KYC whose annual re-confirmation is due blocks too", async () => {
    await db.asRole(U.P1, async (s) => {
      const id = await newEngagement(s);
      await satisfyAcceptanceFacts(s, id);
      await s.as("super");
      await s.exec("update client_kyc set verified_on = current_date - 400, next_review_on = current_date - 35 where client_id = $1", [C.A]);
      await s.as(U.P1);
      expect((await gate(s, id, "planning")).missing.map((m) => m.code)).toContain("kyc_review");
    });
  });
});

describe("sign-offs and materiality (§6.9 SA 300, SA 320)", () => {
  it("evidence before prepare, no self-review, current stage only, materiality before leaving Planning", async () => {
    await db.asRole(U.P1, async (s) => {
      const id = await newEngagement(s);
      await satisfyAcceptanceFacts(s, id);
      await signStage(s, id, "acceptance", "tax_audit", F.docPrivate("A"));
      await s.exec("select advance_audit_stage($1, 'planning', null, null)", [id]);

      // A step of a later stage can't be signed yet.
      expect(userMessage((await sign(s, id, "exec.evidence", "prepare")) as never)).toMatch(/another stage/);
      // plan.strategy needs a working paper.
      expect(userMessage((await sign(s, id, "plan.strategy", "prepare")) as never)).toMatch(/Attach the working paper/);
      // Only the client's own live documents can be attached.
      expect((await s.attempt("select audit_attach_evidence($1, 'plan.strategy', $2::uuid[], null)", [id, [F.docPrivate("B")]])).ok).toBe(false);
      await s.exec("select audit_attach_evidence($1, 'plan.strategy', $2::uuid[], null)", [id, [F.docPrivate("A")]]);
      expect((await sign(s, id, "plan.strategy", "prepare")).ok).toBe(true);
      expect(userMessage((await sign(s, id, "plan.strategy", "review")) as never)).toMatch(/someone else/);
      // N/A needs the step to allow it.
      expect(userMessage((await sign(s, id, "plan.team_briefing", "not_applicable", "Sole practitioner engagement")) as never)).toMatch(/can't be marked not applicable/);
      // A prepared step's only working paper stays until the step is reopened.
      const link = await s.value<string>("select id from audit_engagement_documents where engagement_id = $1 and step_key = 'plan.strategy'", [id]);
      expect(userMessage(await s.fails("select audit_detach_evidence($1)", [link]))).toMatch(/Reopen the step/);
      await s.as(U.M1);
      expect((await sign(s, id, "plan.strategy", "review")).ok).toBe(true);
      expect(userMessage((await sign(s, id, "plan.strategy", "prepare")) as never)).toMatch(/already reviewed/);
      await s.as(U.P1);

      await signStage(s, id, "planning", "tax_audit", F.docPrivate("A"));
      const g = await gate(s, id, "risk_assessment");
      expect(g.missing.map((m) => m.code)).toEqual(["materiality"]);
      // Trivial must stay below performance, which can't exceed overall.
      await s.exec(`update audit_engagements set materiality = '{"basis":"revenue","overall":500000,"performance":375000,"trivial":400000}' where id = $1`, [id]);
      expect((await gate(s, id, "risk_assessment")).missing.map((m) => m.code)).toEqual(["materiality"]);
      await s.exec(`update audit_engagements set materiality = '{"basis":"revenue","base_amount":50000000,"percent":1,"overall":500000,"performance":375000,"trivial":25000}' where id = $1`, [id]);
      expect((await gate(s, id, "risk_assessment")).ok).toBe(true);
      // Two stages at once is refused; going back needs a reason.
      expect((await gate(s, id, "execution")).missing.map((m) => m.code)).toEqual(["one_at_a_time"]);
      await s.exec("select advance_audit_stage($1, 'risk_assessment', null, null)", [id]);
      expect(userMessage(await s.fails("select advance_audit_stage($1, 'planning', null, null)", [id]))).toMatch(/Say why/);
      expect((await s.value<{ stage: string }>("select advance_audit_stage($1, 'planning', 'Materiality to be revised after the revenue restatement', null)", [id])).stage).toBe("planning");
    });
  });
});

describe("archive locks the file (SA 230, §6.9)", () => {
  it("needs the report, UDIN and the steps; then the engagement and its documents are read-only", async () => {
    await db.asRole(U.P1, async (s) => {
      const id = await newEngagement(s);
      await s.exec("select audit_attach_evidence($1, 'comp.representations', $2::uuid[], null)", [id, [F.docPrivate("A")]]);
      // Put the engagement at Reporting with every earlier step done (as the superuser).
      const done = Object.fromEntries(
        AUDIT_STEPS.filter((x) => !x.auditTypes || x.auditTypes.includes("tax_audit")).filter((x) => x.stage !== "reporting" && x.stage !== "archived").map((x) => [x.key, { prepared_by: U.P1.id, prepared_at: "2026-10-01T05:00:00Z", reviewed_by: U.M1.id, reviewed_at: "2026-10-02T05:00:00Z" }]),
      );
      await s.as("super");
      await s.exec("update audit_engagements set stage = 'reporting', checklist = $2 where id = $1", [id, JSON.stringify({ steps: done })]);
      await s.as(U.P1);

      let g = await gate(s, id, "archived");
      expect(g.missing.map((m) => m.code)).toEqual(expect.arrayContaining(["step", "report", "udin"]));
      // Archive-stage steps are signable at Reporting.
      await signStage(s, id, "reporting", "tax_audit", F.docPrivate("A"));
      await signStage(s, id, "archived", "tax_audit", F.docPrivate("A"));
      const reportDate = addDays(todayIST(), -20);
      await s.exec("update audit_engagements set report_type = 'unmodified', report_date = $2 where id = $1", [id, reportDate]);
      expect(userMessage(await s.fails("update audit_engagements set report_date = current_date + 3 where id = $1", [id]))).toMatch(/future/);
      await s.as("super");
      const udinId = await s.value<string>(
        `insert into udin_records (client_id, udin, document_type, document_date, signed_on, generated_on, signing_partner_id, report_form, financial_year)
         values ($1, '26123456AAAABBBB77', 'Tax audit report', $2, $2, $2, $3, '3CA', '2025-26') returning id`,
        [C.A, reportDate, U.P1.id],
      );
      await s.as(U.P1);
      await s.exec("update audit_engagements set udin_record_id = $2 where id = $1", [id, udinId]);
      g = await gate(s, id, "archived");
      expect(g.ok).toBe(true);
      const archived = await s.value<{ stage: string; retain_until: string; documents_retention_extended: number }>("select advance_audit_stage($1, 'archived', null, null)", [id]);
      expect(archived.stage).toBe("archived");
      expect(archived.retain_until).toBe(`${Number(reportDate.slice(0, 4)) + 7}${reportDate.slice(4)}`);
      // Retention only ever extends: the document keeps the later of its own date and the file's.
      expect(await s.value<string>("select retention_until::text from documents where id = $1", [F.docPrivate("A")]) >= archived.retain_until).toBe(true);

      // The engagement is read-only for everyone, the superuser included.
      expect(userMessage(await s.fails("update audit_engagements set notes = 'x' where id = $1", [id]))).toMatch(/archived and read-only/);
      await s.as("super");
      expect(userMessage(await s.fails("update audit_engagements set notes = 'x' where id = $1", [id]))).toMatch(/archived and read-only/);
      await s.as(U.P1);
      // Its documents: no edits, no deletion, no new version, no tags; retention may only be extended.
      expect(userMessage(await s.fails("update documents set title = 'Changed' where id = $1", [F.docPrivate("A")]))).toMatch(/archived tax audit file/);
      expect(userMessage(await s.fails("update documents set deleted_at = now() where id = $1", [F.docPrivate("A")]))).toMatch(/read-only/);
      expect(userMessage(await s.fails("update documents set retention_until = retention_until - 1 where id = $1", [F.docPrivate("A")]))).toMatch(/read-only/);
      expect(await s.exec("update documents set retention_until = retention_until + 30 where id = $1", [F.docPrivate("A")])).toBe(1);
      expect(userMessage(await s.fails("insert into document_tags (document_id, tag) values ($1, 'late')", [F.docPrivate("A")]))).toMatch(/read-only/);
      expect(
        userMessage(await s.fails("insert into document_versions (document_id, version, file_name, file_size, storage_path, uploaded_by) values ($1, 9, 'x.pdf', 1, 'client-documents/' || $2 || '/x.pdf', $3)", [F.docPrivate("A"), C.A, U.P1.id])),
      ).toMatch(/read-only/);
      // Signing and removing are over; adding is an amendment with a note.
      expect((await sign(s, id, "arch.assembly", "reopen")).ok).toBe(false);
      const link = await s.value<string>("select id from audit_engagement_documents where engagement_id = $1 limit 1", [id]);
      expect(userMessage(await s.fails("select audit_detach_evidence($1)", [link]))).toMatch(/archived/);
      expect(userMessage(await s.fails("select audit_attach_evidence($1, 'exec.evidence', $2::uuid[], null)", [id, [F.docShared("A")]]))).toMatch(/amendment/);
      const added = await s.value<{ added: number; amendment: boolean }>("select audit_attach_evidence($1, 'exec.evidence', $2::uuid[], 'Bank confirmation received after the report date')", [id, [F.docShared("A")]]);
      expect(added).toMatchObject({ added: 1, amendment: true });
      expect(await s.value<boolean>("select is_amendment from audit_engagement_documents where engagement_id = $1 and document_id = $2", [id, F.docShared("A")])).toBe(true);
      // Nothing moves an archived file.
      expect(userMessage(await s.fails("select advance_audit_stage($1, 'reporting', 'Reopen the file', null)", [id]))).toMatch(/archived/);
    });
  });
});

describe("ceilings (§6.8)", () => {
  it("the company audit limit counts the partner's accepted countable audits and blocks a 21st", async () => {
    await db.asRole(U.P1, async (s) => {
      const listed = { is_public: true, paid_up_capital: 500000000, turnover: 9000000000 };
      const id = await newEngagement(s, { client: C.C, type: "statutory_companies_act", fy: "2025-26", profile: listed });
      expect(await s.value<boolean>("select counts_towards_company_audit_limit from audit_engagements where id = $1", [id])).toBe(true);
      // A small private company doesn't count.
      const small = await newEngagement(s, { client: C.C, type: "statutory_companies_act", fy: "2025-26", profile: { is_public: false, paid_up_capital: 5000000, turnover: 80000000 } });
      expect(await s.value<boolean>("select counts_towards_company_audit_limit from audit_engagements where id = $1", [small])).toBe(false);
      // Unknown facts block the gate until recorded.
      const unknown = await newEngagement(s, { client: C.C, type: "statutory_companies_act", fy: "2025-26", profile: null });
      expect((await gate(s, unknown, "planning")).missing.map((m) => m.code)).toContain("company_facts");

      await s.as("super");
      for (let i = 0; i < 17; i++) {
        await s.exec(
          "insert into audit_engagements (client_id, audit_type, financial_year, engagement_partner_id, stage, company_profile) values ($1, 'statutory_companies_act', '2025-26', $2, 'planning', $3)",
          [C.C, P1E, JSON.stringify(listed)],
        );
      }
      await s.as(U.P1);
      expect(await s.value("select audit_limit_check($1)", [id])).toMatchObject({ kind: "company", level: "warn", position: 18 });
      await s.as("super");
      for (let i = 0; i < 3; i++) {
        await s.exec(
          "insert into audit_engagements (client_id, audit_type, financial_year, engagement_partner_id, stage, company_profile) values ($1, 'statutory_companies_act', '2025-26', $2, 'execution', $3)",
          [C.C, P1E, JSON.stringify(listed)],
        );
      }
      await s.as(U.P1);
      expect(await s.value("select audit_limit_check($1)", [id])).toMatchObject({ kind: "company", level: "block", position: 21 });
      expect((await gate(s, id, "planning")).missing.map((m) => m.code)).toContain("company_limit");
    });
  });

  it("a tax audit over the ICAI ceiling needs a Partner's confirmation with a reason", async () => {
    await db.asRole(U.P1, async (s) => {
      const id = await newEngagement(s, { type: "tax_audit" });
      // Bring P1 to exactly 60 for the year with audits signed elsewhere: this one would be the 61st.
      const before = await s.value<{ current: number }>("select audit_limit_check($1)", [id]);
      await s.as("super");
      await s.exec(
        `insert into tax_audit_external_counts (member_profile_id, financial_year, audits_signed_elsewhere) values ($1, public.financial_year_label(public.today_ist()), $2)
         on conflict (member_profile_id, financial_year) do update set audits_signed_elsewhere = tax_audit_external_counts.audits_signed_elsewhere + excluded.audits_signed_elsewhere`,
        [U.P1.id, 60 - before.current],
      );
      await s.as(U.P1);
      expect(await s.value("select audit_limit_check($1)", [id])).toMatchObject({ kind: "tax_audit", level: "confirm", position: 61, limit: 60 });
      expect((await gate(s, id, "planning")).missing.map((m) => m.code)).toContain("tax_audit_ceiling");
      await s.as(U.M1);
      expect(userMessage(await s.fails("select confirm_audit_limit_override($1, 'Long-standing client, partner capacity reviewed')", [id]))).toMatch(/Only a Partner/);
      await s.as(U.P1);
      expect(userMessage(await s.fails("select confirm_audit_limit_override($1, 'ok')", [id]))).toMatch(/Record why/);
      await s.exec("select confirm_audit_limit_override($1, 'Long-standing client; capacity reviewed with the second partner')", [id]);
      const g = await gate(s, id, "planning");
      expect(g.missing.map((m) => m.code)).not.toContain("tax_audit_ceiling");
      expect(g.warnings.map((w) => w.code)).toContain("limit");
    });
  });
});

describe("parity with lib/domain (the SQL is the real control; the UI explains it)", () => {
  it("the step definitions match AUDIT_STEPS", async () => {
    await db.asRole(U.P1, async (s) => {
      const rows = await s.rows<{ key: string; stage: string; title: string; sa_refs: string[]; evidence_required: boolean; allow_na: boolean; audit_types: string[] | null; system_check: string | null }>(
        "select key, stage, title, sa_refs, evidence_required, allow_na, audit_types, system_check from audit_step_definitions order by sort_order",
      );
      expect(rows.map((r) => r.key)).toEqual(AUDIT_STEPS.map((x) => x.key));
      for (const [i, step] of AUDIT_STEPS.entries()) {
        expect(rows[i]).toEqual({
          key: step.key,
          stage: step.stage,
          title: step.title,
          sa_refs: [...step.sa],
          evidence_required: step.evidenceRequired,
          allow_na: step.allowNa,
          audit_types: step.auditTypes ? [...step.auditTypes] : null,
          system_check: step.system ?? null,
        });
      }
    });
  });

  it("the seeded parameters match AUDIT_SEED_PARAMETERS and DPDP_SEED_PARAMETERS", async () => {
    await db.asRole(U.P1, async (s) => {
      for (const p of [...AUDIT_SEED_PARAMETERS, ...DPDP_SEED_PARAMETERS]) {
        const row = await s.one<{ value: unknown; effective_to: string | null; verified: boolean; source_ref: string }>(
          "select value, effective_to::text, verified, source_ref from statutory_parameters where key = $1 and effective_from = $2",
          [p.key, p.effectiveFrom],
        );
        expect(row).toEqual({ value: p.value, effective_to: p.effectiveTo, verified: p.verified, source_ref: p.sourceRef });
      }
    });
  });

  it("small company and the company-limit count agree with the TS rules", async () => {
    const rows = await db.asRole(U.P1, (s) => s.rows<{ key: string; value: unknown; effective_from: string; effective_to: string | null; verified: boolean }>("select key, value, effective_from::text, effective_to::text, verified from statutory_parameters where key like 'company.%' or key like 'caro.%' or key like 'audit.%'"));
    const paramRows = rows.map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
    const cases: Array<Record<string, unknown>> = [
      { is_public: false, paid_up_capital: 90000000, turnover: 900000000 },
      { is_public: false, paid_up_capital: 110000000, turnover: 900000000 },
      { is_public: true, paid_up_capital: 1000000, turnover: 1000000 },
      { is_public: false, is_holding_or_subsidiary: true, paid_up_capital: 1000000, turnover: 1000000 },
      { is_public: false, paid_up_capital: 2000000000, turnover: 90000000000 },
      { is_public: false, is_one_person_company: true, paid_up_capital: 100000, turnover: 100000 },
      { is_public: null, paid_up_capital: 100000, turnover: 100000 },
      { is_public: false, paid_up_capital: null, turnover: 100000 },
    ];
    for (const on of ["2024-03-31", "2026-03-31"]) {
      const params = resolveAuditParams(paramRows, on).params;
      const exclusion = 100_00_00_000_00;
      for (const c of cases) {
        const sql = await db.asRole(U.P1, (s) => s.one<{ small: boolean | null; counts: boolean | null }>("select is_small_company($1::jsonb, $2::date) as small, company_counts_towards_audit_limit($1::jsonb, $2::date) as counts", [JSON.stringify(c), on]));
        const f = readCompanyFacts(c);
        expect(sql.small).toBe(isSmallCompany(f, params.smallCompany));
        expect(sql.counts).toBe(countsTowardsCompanyLimit(f, exclusion, params.smallCompany));
      }
    }
  });

  it("kyc_missing agrees with kycCompleteness for each category", async () => {
    await db.asRole(U.P1, async (s) => {
      const today = todayIST();
      const variants: Array<{ category: string; persons: unknown; cin: string | null; pan: string | null; desc: string | null; doc: string | null; types: string[] | null }> = [
        { category: "corporate", persons: [], cin: null, pan: null, desc: null, doc: null, types: null },
        { category: "corporate", persons: [{ name: "A", address: "Blr" }], cin: "U1", pan: "AAACA1234A", desc: "Trade", doc: F.docPrivate("A"), types: ["tax_audit"] },
        { category: "corporate", persons: [{ name: "A", address: "Blr", din: "01234567" }], cin: "U1", pan: "AAACA1234A", desc: "Trade", doc: F.docPrivate("A"), types: ["tax_audit"] },
        { category: "non_corporate", persons: [{ name: "B", address: "Blr", pan: "ABCPB1234C" }, { name: "  " }], cin: null, pan: "AAAFA1234A", desc: "Firm", doc: F.docPrivate("A"), types: ["internal"] },
        { category: "non_corporate", persons: [{ name: "B", address: "Blr" }], cin: null, pan: "AAAFA1234A", desc: "Firm", doc: F.docPrivate("A"), types: ["internal"] },
        { category: "individual_proprietor", persons: [], cin: null, pan: "ABCPD1234E", desc: "Shop", doc: null, types: [] },
      ];
      for (const v of variants) {
        await s.as("super");
        await s.exec(
          "update client_kyc set entity_category = $2, principal_persons = $3::jsonb, cin_llpin = $4, pan = $5, business_description = $6, last_audited_fs_document_id = $7, engagement_types = $8 where client_id = $1",
          [C.A, v.category, JSON.stringify(v.persons), v.cin, v.pan, v.desc, v.doc, v.types],
        );
        await s.as(U.P1);
        const sqlMissing = await s.value<string[]>("select kyc_missing($1)", [C.A]);
        const name = await s.value<string>("select coalesce(legal_name, display_name) from clients where id = $1", [C.A]);
        const ts = kycCompleteness(
          {
            entityCategory: v.category as never,
            name,
            pan: v.pan,
            cinLlpin: v.cin,
            businessDescription: v.desc,
            lastAuditedFsDocumentId: v.doc,
            engagementTypes: v.types,
            principalPersons: (v.persons as Array<Record<string, string>>).filter((p) => p.name && p.name.trim()).map((p) => ({ name: p.name, address: p.address ?? null, pan: p.pan ?? null, din: p.din ?? null })),
          },
          today,
        );
        expect(sqlMissing).toEqual(ts.missing);
      }
    });
  });
});

describe("DPDP data requests (§6.10)", () => {
  it("due date from the type, Partner-only writes, closing needs the response and, for erasure, what is kept", async () => {
    await db.asRole(U.P1, async (s) => {
      const r = await s.one<{ id: string; due_by: string; created_by: string }>(
        "insert into data_requests (subject, type, subject_type, contact, channel, details) values ('Meera Shah', 'erasure', 'lead', 'meera@example.in', 'email', 'Asked us to delete her enquiry') returning id, due_by::text, created_by",
      );
      expect(r.due_by).toBe(addDays(todayIST(), 90));
      expect(r.created_by).toBe(U.P1.id);
      expect(userMessage(await s.fails("update data_requests set status = 'completed' where id = $1", [r.id]))).toMatch(/response/);
      expect(userMessage(await s.fails("update data_requests set status = 'completed', response = 'Done' where id = $1", [r.id]))).toMatch(/retained/);
      await s.exec("update data_requests set status = 'completed', response = 'Erased.', retained_explanation = 'Nothing is retained.' where id = $1", [r.id]);
      expect(await s.value<string | null>("select closed_at::text from data_requests where id = $1", [r.id])).not.toBeNull();
      expect(await s.value<boolean>("select is_open from data_requests_view where id = $1", [r.id])).toBe(false);
      expect(await s.value<number>("select count(*)::int from inbox_action_items where entity_id = $1", [r.id])).toBe(0);
      await s.exec("update data_requests set status = 'in_progress' where id = $1", [r.id]);
      expect(await s.value<string | null>("select closed_at from data_requests where id = $1", [r.id])).toBeNull();
      expect(userMessage(await s.fails("update data_requests set status = 'closed_by_hand' where id = $1", [r.id]))).toMatch(/data_requests_status_values|violates/);
    });
    await db.asRole(U.M1, async (s) => {
      expect(visibleCount(await s.attempt("select 1 from data_requests"))).toBeGreaterThan(0);
      expect((await s.attempt("insert into data_requests (subject, type) values ('X', 'access')")).ok).toBe(false);
    });
    await db.asRole(U.E1, async (s) => {
      expect(visibleCount(await s.attempt("select 1 from data_requests_view"))).toBe(0);
    });
  });

  it("an incident closes only when the breach checklist is complete, with steps after detection", async () => {
    await db.asRole(U.P1, async (s) => {
      const id = await s.value<string>("insert into data_incidents (detected_at, title, description, severity) values (now() - interval '2 hours', 'Laptop lost', 'A staff laptop was lost on the bus', 'high') returning id");
      expect(userMessage(await s.fails("update data_incidents set contained_at = now() - interval '5 hours' where id = $1", [id]))).toMatch(/before the breach was detected/);
      expect(userMessage(await s.fails("update data_incidents set closed_at = now() where id = $1", [id]))).toMatch(/Close the incident once/);
      await s.exec(
        "update data_incidents set contained_at = now(), assessed_at = now(), assessment = 'Disk encrypted', board_notified_at = now(), principals_notified_at = now(), root_cause = 'No remote wipe' where id = $1",
        [id],
      );
      await s.exec("update data_incidents set closed_at = now() where id = $1", [id]);
      const v = await s.one<{ is_open: boolean; steps_done: number; closed_by: string }>("select is_open, steps_done, closed_by from data_incidents_view where id = $1", [id]);
      expect(v).toEqual({ is_open: false, steps_done: 5, closed_by: U.P1.id });
    });
    await db.asRole(U.M1, async (s) => {
      expect((await s.attempt("insert into data_incidents (detected_at, description) values (now(), 'Manager entry')")).ok).toBe(false);
    });
  });
});

describe("privacy notices (§6.10, §7.22 welcome gate)", () => {
  it("drafts are edited, publishing makes one current, a published version is frozen", async () => {
    await db.asRole(U.P1, async (s) => {
      const body = `# Privacy notice\n\n${"We hold your name, PAN and contact details to file your returns. ".repeat(6)}\n\nComplain to the Data Protection Board.`;
      // A draft can't be inserted as published.
      expect(userMessage(await s.fails("insert into privacy_notices (version, body, is_current) values ('v2', $1, true)", [body]))).toMatch(/draft/);
      const id = await s.value<string>("insert into privacy_notices (version, body, change_summary) values ('v2', $1, 'Adds WhatsApp groups') returning id", [body]);
      await s.exec("update privacy_notices set body = body || ' Updated.' where id = $1", [id]);
      await s.as(U.M1);
      expect(userMessage(await s.fails("select publish_privacy_notice($1, null)", [id]))).toMatch(/Only a Partner/);
      await s.as(U.P1);
      const out = await s.value<{ version: string; already: boolean }>("select publish_privacy_notice($1, null)", [id]);
      expect(out).toMatchObject({ version: "v2", already: false });
      expect(await s.value<string[]>("select array_agg(version order by version) from privacy_notices where is_current")).toEqual(["v2"]);
      expect(userMessage(await s.fails("update privacy_notices set body = 'x' where id = $1", [id]))).toMatch(/new version/);
      expect(userMessage(await s.fails("delete from privacy_notices where id = $1", [id]))).toMatch(/can't be deleted/);
      // The portal reads the current published version.
      await s.as(U.CA);
      expect(await s.value<string>("select version from privacy_notices order by is_current desc, published_at desc limit 1")).toBe("v2");
    });
  });
});

describe("quality records (§6.8, §7.15.4, §12)", () => {
  it("independence: a yes needs details; each person declares for themselves", async () => {
    await db.asRole(U.E3, async (s) => {
      const e3 = U.E3.employeeId!;
      expect(userMessage(await s.fails(`insert into independence_declarations (employee_id, financial_year, answers) values ($1, '2026-27', '{"financial_interest": true}')`, [e3]))).toMatch(/details/);
      expect(userMessage(await s.fails(`insert into independence_declarations (employee_id, financial_year, answers) values ($1, '2026-27', '{"financial_interest": "maybe"}')`, [e3]))).toMatch(/yes or no/);
      await s.exec(`insert into independence_declarations (employee_id, financial_year, answers, details) values ($1, '2026-27', '{"financial_interest": true, "relationships": false}', 'Holds 100 shares of a listed client; not on that team')`, [e3]);
      expect(await s.value<string>("select declared_by from independence_declarations where employee_id = $1", [e3])).toBe(U.E3.id);
      expect((await s.attempt(`insert into independence_declarations (employee_id, financial_year, answers) values ($1, '2026-27', '{}')`, [U.E4.employeeId!])).ok).toBe(false);
    });
    await db.asRole(U.P1, async (s) => {
      const rows = await s.rows<{ employee_id: string; declaration_id: string | null }>("select employee_id, declaration_id from independence_register('2026-27')");
      expect(rows.length).toBeGreaterThan(3);
      expect(rows.find((r) => r.employee_id === U.E1.employeeId)?.declaration_id).toBeTruthy();
    });
  });

  it("peer reviews and restore drills keep their facts straight; Managers read only", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(userMessage(await s.fails("insert into peer_reviews (period_from, period_to, reviewer_name, status) values ('2023-04-01', '2026-03-31', 'CA R', 'completed')"))).toMatch(/certificate number/);
      expect(userMessage(await s.fails("insert into restore_drills (performed_on, outcome) values (current_date, 'failed')"))).toMatch(/restore_drills_issues_when_not_clean|violates/);
      expect(userMessage(await s.fails("insert into restore_drills (performed_on, outcome) values (today_ist() + 1, 'passed')"))).toMatch(/future/);
      expect(await s.value<string>("insert into restore_drills (performed_on, outcome, restored_to, duration_minutes) values (current_date, 'passed', 'Staging project', 42) returning performed_by")).toBe(U.P1.id);
      expect(userMessage(await s.fails("update quality_manual_items set last_reviewed_on = today_ist() + 1 where id = (select id from quality_manual_items limit 1)"))).toMatch(/future/);
    });
    await db.asRole(U.M1, async (s) => {
      expect(visibleCount(await s.attempt("select 1 from peer_reviews"))).toBeGreaterThan(0);
      expect(await s.exec("update quality_manual_items set notes = 'x'")).toBe(0);
      expect((await s.attempt("insert into restore_drills (performed_on, outcome) values (current_date, 'passed')")).ok).toBe(false);
    });
  });

  it("the KYC register, disposal list and retention summary are read models only", async () => {
    await db.asRole(U.P1, async (s) => {
      const rows = await s.rows<{ client_id: string; kyc_state: string }>("select client_id, kyc_state from kyc_register");
      expect(rows.find((r) => r.client_id === C.A)?.kyc_state).toBe("incomplete");
      expect(Array.isArray(await s.rows("select * from retention_summary()"))).toBe(true);
      for (const v of ["kyc_register", "documents_for_disposal", "audit_engagements_list", "data_requests_view", "data_incidents_view"]) {
        expect((await s.attempt(`delete from ${v}`)).ok).toBe(false);
      }
    });
  });
});
