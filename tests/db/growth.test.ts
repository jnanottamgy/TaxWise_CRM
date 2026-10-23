/**
 * Leads, quotations and the acceptance register (§7.5, §7.23): migrations 0142–0147.
 *   - leads: Lost needs a reason, closed_at follows Won/Lost, a converted lead stays Won, the job's
 *     bookkeeping isn't activity;
 *   - save_quotation: Draft-only, totals from the lines (half-up), optimistic concurrency;
 *   - the status guard: content fixed once sent, the workflow's moves only, system columns,
 *     one conversion, an accepted quotation kept;
 *   - approvals: Manager over the limit → Pending approval; only a Partner approves or returns;
 *   - sending: logs, follow-ups on IST days 3/7/14, the lead to Proposal sent;
 *   - revise: a new Draft with the same lines, the old one Superseded and its link closed;
 *   - the public page's functions: service role only; views; accept / decline with every state check;
 *   - expiry, follow-ups, analytics; Employees see none of it.
 */
import { describe, expect, it } from "vitest";
import { C, U, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("growth");

async function asService(s: Session): Promise<void> {
  await s.as("super");
  await s.exec("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
  await s.exec("set local role service_role");
}

type Saved = { id: string; quotation_number: string; status: string; updated_at: string; subtotal: string; tax_amount: string; total: string; conflict: boolean };

function header(over: Record<string, unknown> = {}) {
  return {
    lead_id: null,
    client_id: null,
    client_name: "Ramesh Gupta",
    client_email: "ramesh@guptafoods.in",
    client_phone: "9845012345",
    client_company: "Gupta Foods Pvt Ltd",
    client_gstin: null,
    place_of_supply_code: "29",
    issue_date: null,
    valid_until: "2099-12-31",
    notes: null,
    terms: "Fees exclude out-of-pocket expenses.",
    ...over,
  };
}

const LINES = [
  { description: "GST returns (GSTR-1 and GSTR-3B)", service_type: "gst", frequency: "monthly", quantity: 12, unit_price: 3333.33, tax_rate: 18 },
  { description: "Income tax return", service_type: "income_tax", frequency: "annual", quantity: 1, unit_price: 7500.5, tax_rate: 18 },
];

async function save(s: Session, id: string | null, h = header(), items: unknown[] = LINES, expected: string | null = null): Promise<Saved> {
  return s.one<Saved>("select * from save_quotation($1, $2, $3::jsonb, $4::jsonb)", [id, expected, JSON.stringify(h), JSON.stringify(items)]);
}

async function lead(s: Session, status = "contacted"): Promise<string> {
  return s.value<string>("insert into leads (name, company, email, created_by, status) values ('Ramesh Gupta', 'Gupta Foods', 'ramesh@guptafoods.in', auth.uid(), $1::lead_status) returning id", [status]);
}

async function send(s: Session, id: string, updatedAt: string | null = null): Promise<{ status: string; first_send: boolean; sent_at: string }> {
  return s.one("select * from mark_quotation_sent($1, $2, 'email', null, 'Quotation', 're_123', 'initial')", [id, updatedAt]);
}

describe("leads (§7.5.1)", () => {
  it("Lost needs a reason, closes the lead, and reopening clears the reason", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await lead(s);
      expect(userMessage(await s.fails("update leads set status = 'lost' where id = $1", [id]))).toMatch(/Say why the lead was lost/);
      await s.exec("update leads set status = 'lost', lost_reason = 'Chose a firm near their office', lost_category = 'competitor' where id = $1", [id]);
      const lost = await s.one<{ closed_at: string | null; lost_category: string }>("select closed_at, lost_category from leads where id = $1", [id]);
      expect(lost.closed_at).not.toBeNull();
      expect(lost.lost_category).toBe("competitor");
      await s.exec("update leads set status = 'negotiation' where id = $1", [id]);
      const open = await s.one<{ closed_at: string | null; lost_reason: string | null; lost_category: string | null }>(
        "select closed_at, lost_reason, lost_category from leads where id = $1",
        [id],
      );
      expect(open).toEqual({ closed_at: null, lost_reason: null, lost_category: null });
      await s.exec("update leads set status = 'lost', lost_reason = 'No reply after three calls', lost_category = 'no_response' where id = $1", [id]);
      expect((await s.attempt("update leads set lost_category = 'bribery' where id = $1", [id])).ok).toBe(false);
    });
  });

  it("a converted lead stays Won and keeps its client", async () => {
    await db.asRole(U.P1, async (s) => {
      const id = await lead(s);
      await s.exec("update leads set status = 'won', converted_client_id = $2 where id = $1", [id, C.A]);
      expect(userMessage(await s.fails("update leads set status = 'negotiation' where id = $1", [id]))).toMatch(/stays Won/);
      expect(userMessage(await s.fails("update leads set converted_client_id = $2 where id = $1", [id, C.B]))).toMatch(/already been converted/);
    });
  });

  it("the reminders job's bookkeeping doesn't count as activity", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await lead(s);
      await s.as("super");
      await s.exec("update leads set last_activity_at = now() - interval '20 days' where id = $1", [id]);
      await s.exec("update leads set stale_notified_at = now(), follow_up_reminded_for = now() where id = $1", [id]);
      const stale = await s.value<boolean>("select last_activity_at < now() - interval '19 days' from leads where id = $1", [id]);
      expect(stale).toBe(true);
      await s.exec("update leads set requirement_notes = 'Called back' where id = $1", [id]);
      expect(await s.value<boolean>("select last_activity_at > now() - interval '1 minute' from leads where id = $1", [id])).toBe(true);
    });
  });

  it("leads_list flags untouched leads and counts open quotations", async () => {
    await db.asRole(U.P1, async (s) => {
      const id = await lead(s);
      const q = await save(s, null, header({ lead_id: id }));
      await send(s, q.id);
      await s.as("super");
      await s.exec("update leads set last_activity_at = now() - interval '15 days' where id = $1", [id]);
      await s.as(U.P1);
      const row = await s.one<{ is_stale: boolean; open_quotations: number; open_quotation_value: string; latest_quotation_status: string; status: string }>(
        "select is_stale, open_quotations, open_quotation_value::text, latest_quotation_status::text, status::text from leads_list where id = $1",
        [id],
      );
      expect(row).toMatchObject({ is_stale: true, open_quotations: 1, latest_quotation_status: "sent", status: "proposal_sent" });
      expect(row.open_quotation_value).toBe(q.total);
    });
  });
});

describe("save_quotation (§7.5.2)", () => {
  it("creates a numbered Draft with totals from half-up rounded lines", async () => {
    await db.asRole(U.M1, async (s) => {
      const q = await save(s, null);
      expect(q.quotation_number).toMatch(/^TW-Q\/\d{2}-\d{2}\/\d{4}$/);
      expect(q.status).toBe("draft");
      // 12 × 3,333.33 = 39,999.96 → GST 7,199.99 (7,199.9928); 7,500.50 → GST 1,350.09
      expect([q.subtotal, q.tax_amount, q.total]).toEqual(["47500.46", "8550.08", "56050.54"]);
      const lines = await s.rows<{ tax_amount: string; total: string; sort_order: number }>(
        "select tax_amount::text, total::text, sort_order from quotation_items where quotation_id = $1 order by sort_order",
        [q.id],
      );
      expect(lines).toEqual([
        { tax_amount: "7199.99", total: "47199.95", sort_order: 0 },
        { tax_amount: "1350.09", total: "8850.59", sort_order: 1 },
      ]);
      expect(await s.value<string>("select created_by::text from quotations where id = $1", [q.id])).toBe(U.M1.id);
    });
  });

  it("refuses a stale save, a missing name or email, and anyone but Partners and Managers", async () => {
    await db.asRole(U.M1, async (s) => {
      const q = await save(s, null);
      const ok = await save(s, q.id, header({ notes: "Updated" }), LINES, q.updated_at);
      expect(ok.conflict).toBe(false);
      // Another session saved after this one loaded the draft (one transaction shares now(), so stand in for it).
      const stale = await save(s, q.id, header({ notes: "Lost update" }), LINES, "2026-01-01T00:00:00Z");
      expect(stale.conflict).toBe(true);
      expect(await s.value("select notes from quotations where id = $1", [q.id])).toBe("Updated");
      expect(userMessage(await s.fails("select * from save_quotation(null, null, $1::jsonb, '[]'::jsonb)", [JSON.stringify(header({ client_email: "" }))]))).toMatch(
        /name and email/,
      );
    });
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select * from save_quotation(null, null, $1::jsonb, '[]'::jsonb)", [JSON.stringify(header())]))).toMatch(/Partners and Managers/);
    });
  });
});

describe("the quotation status guard (§7.5.3 'never edited in place')", () => {
  it("fixes content and lines once sent; only the workflow moves status", async () => {
    await db.asRole(U.P1, async (s) => {
      const q = await save(s, null);
      await send(s, q.id);
      expect(userMessage(await s.fails("update quotations set notes = 'changed' where id = $1", [q.id]))).toMatch(/is sent and can't be edited/);
      expect(userMessage(await s.fails("update quotation_items set unit_price = 1 where quotation_id = $1", [q.id]))).toMatch(/lines can't be changed/);
      expect(userMessage(await s.fails("delete from quotation_items where quotation_id = $1", [q.id]))).toMatch(/lines can't be changed/);
      for (const to of ["viewed", "accepted", "rejected", "expired", "draft"]) {
        expect(userMessage(await s.fails(`update quotations set status = '${to}' where id = $1`, [q.id])), to).toMatch(/can't go from sent/);
      }
      expect(userMessage(await s.fails("update quotations set status = 'superseded' where id = $1", [q.id]))).toMatch(/only by a revision/);
      expect(userMessage(await s.fails("update quotations set view_count = 99 where id = $1", [q.id]))).toMatch(/can't be changed/);
      expect(userMessage(await s.fails("update quotations set token = repeat('a', 43) where id = $1", [q.id]))).toMatch(/can't be changed/);
      expect(userMessage(await s.fails("select * from save_quotation($1, null, $2::jsonb, '[]'::jsonb)", [q.id, JSON.stringify(header())]))).toMatch(/is sent and can't be edited/);
    });
  });

  it("stamps the conversion once, on an accepted quotation, and keeps accepted quotations", async () => {
    await db.asRole(U.P1, async (s) => {
      const q = await save(s, null);
      expect(userMessage(await s.fails("update quotations set converted_client_id = $2 where id = $1", [q.id, C.A]))).toMatch(/Only an accepted quotation/);
      await send(s, q.id);
      const token = await s.value<string>("select token from quotations where id = $1", [q.id]);
      await asService(s);
      await s.value("select respond_to_quotation($1, 'accept', 'Ramesh Gupta')", [token]);
      await s.as(U.P1);
      await s.exec("update quotations set converted_client_id = $2 where id = $1", [q.id, C.A]);
      expect(userMessage(await s.fails("update quotations set converted_client_id = $2 where id = $1", [q.id, C.B]))).toMatch(/already been converted/);
      expect(userMessage(await s.fails("update quotations set deleted_at = now() where id = $1", [q.id]))).toMatch(/can't be deleted/);
    });
  });
});

describe("approvals (§7.5.2)", () => {
  it("a Manager's quotation over a null limit goes to a Partner, who approves or returns it", async () => {
    await db.asRole(U.M1, async (s) => {
      const q = await save(s, null);
      expect(userMessage(await s.fails("select * from mark_quotation_sent($1, null, 'email', null)", [q.id]))).toMatch(/over the quotation approval limit/);
      const sub = await s.one<{ status: string; updated_at: string }>("select * from submit_quotation_for_approval($1, $2)", [q.id, q.updated_at]);
      expect(sub.status).toBe("pending_approval");
      expect(userMessage(await s.fails("select * from decide_quotation_approval($1, null, 'approve')", [q.id]))).toMatch(/Only a Partner/);
      expect(userMessage(await s.fails("select * from mark_quotation_sent($1, null, 'email', null)", [q.id]))).toMatch(/waits for a Partner/);

      await s.as(U.P1);
      expect(userMessage(await s.fails("select * from decide_quotation_approval($1, null, 'return', '  ')", [q.id]))).toMatch(/Say what needs to change/);
      const ret = await s.one<{ status: string; updated_at: string }>("select * from decide_quotation_approval($1, $2, 'return', 'Split the audit fee by year')", [q.id, sub.updated_at]);
      expect(ret.status).toBe("draft");
      expect(await s.value("select approval_note from quotations where id = $1", [q.id])).toBe("Split the audit fee by year");

      await s.as(U.M1);
      const again = await s.one<{ updated_at: string }>("select * from submit_quotation_for_approval($1, $2)", [q.id, ret.updated_at]);
      await s.as(U.P1);
      expect(userMessage(await s.fails("select * from decide_quotation_approval($1, '2026-01-01T00:00:00Z', 'approve')", [q.id]))).toMatch(/^CONFLICT: /);
      const ok = await s.one<{ status: string }>("select * from decide_quotation_approval($1, $2, 'approve')", [q.id, again.updated_at]);
      expect(ok.status).toBe("approved");
      const who = await s.one<{ approved_by: string }>("select approved_by::text from quotations where id = $1", [q.id]);
      expect(who.approved_by).toBe(U.P1.id);

      await s.as(U.M1);
      expect((await send(s, q.id)).status).toBe("sent");
    });
  });

  it("Partners skip approval, and a Manager within the limit sends directly", async () => {
    await db.asRole(U.P1, async (s) => {
      const q = await save(s, null);
      expect(userMessage(await s.fails("select * from submit_quotation_for_approval($1, null)", [q.id]))).toMatch(/needs no approval/);
      expect((await send(s, q.id)).status).toBe("sent");
    });
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set quotation_approval_limit = 100000");
      await s.as(U.M1);
      const q = await save(s, null);
      expect(userMessage(await s.fails("select * from submit_quotation_for_approval($1, null)", [q.id]))).toMatch(/within the approval limit/);
      expect((await send(s, q.id)).status).toBe("sent");
    });
  });
});

describe("sending (§7.5.3)", () => {
  it("logs the email, schedules the follow-ups on IST days 3, 7 and 14 once, and moves the lead on", async () => {
    await db.asRole(U.P1, async (s) => {
      const l = await lead(s, "quotation_requested");
      const q = await save(s, null, header({ lead_id: l }));
      const first = await send(s, q.id, q.updated_at);
      expect(first).toMatchObject({ status: "sent", first_send: true });
      const again = await send(s, q.id);
      expect(again.first_send).toBe(false);
      expect(await s.value<number>("select count(*)::int from quotation_email_logs where quotation_id = $1 and status = 'sent' and provider_message_id = 're_123'", [q.id])).toBe(2);
      const fus = await s.rows<{ follow_up_day: number; due: string; sent_day: string }>(
        `select f.follow_up_day, (f.scheduled_at at time zone 'Asia/Kolkata')::text as due,
                ((q.sent_at at time zone 'Asia/Kolkata')::date)::text as sent_day
           from quotation_follow_ups f join quotations q on q.id = f.quotation_id where f.quotation_id = $1 order by 1`,
        [q.id],
      );
      expect(fus.map((f) => f.follow_up_day)).toEqual([3, 7, 14]);
      for (const f of fus) {
        const expected = new Date(`${f.sent_day}T00:00:00Z`);
        expected.setUTCDate(expected.getUTCDate() + f.follow_up_day);
        expect(f.due).toBe(`${expected.toISOString().slice(0, 10)} 00:00:00`);
      }
      expect(await s.value("select status::text from leads where id = $1", [l])).toBe("proposal_sent");
    });
  });

  it("refuses a quotation without lines or past its validity", async () => {
    await db.asRole(U.P1, async (s) => {
      const empty = await save(s, null, header(), []);
      expect(userMessage(await s.fails("select * from mark_quotation_sent($1, null, 'email', null)", [empty.id]))).toMatch(/at least one line/);
      const old = await save(s, null);
      await s.as("super");
      await s.exec("update quotations set issue_date = '2026-01-01', valid_until = '2026-01-31' where id = $1", [old.id]);
      await s.as(U.P1);
      expect(userMessage(await s.fails("select * from mark_quotation_sent($1, null, 'whatsapp_handoff', '919845012345')", [old.id]))).toMatch(/valid-until date has passed/);
    });
  });

  it("records a follow-up and skips the earlier ones still waiting", async () => {
    await db.asRole(U.P1, async (s) => {
      const q = await save(s, null);
      await send(s, q.id);
      await s.value("select * from record_quotation_follow_up($1, 7, 'whatsapp_handoff', '919845012345', null, 'handed_off')", [q.id]);
      const rows = await s.rows<{ follow_up_day: number; status: string }>("select follow_up_day, status from quotation_follow_ups where quotation_id = $1 order by 1", [q.id]);
      expect(rows).toEqual([
        { follow_up_day: 3, status: "skipped" },
        { follow_up_day: 7, status: "sent" },
        { follow_up_day: 14, status: "pending" },
      ]);
      expect(await s.value("select email_type from quotation_email_logs where quotation_id = $1 and status = 'handed_off'", [q.id])).toBe("follow_up_7");
      expect(userMessage(await s.fails("select * from record_quotation_follow_up($1, 7, 'email', null)", [q.id]))).toMatch(/already been sent/);
    });
  });
});

describe("revise (§7.5.3)", () => {
  it("creates a Draft revision with the same lines, a new number and link, and supersedes the old one", async () => {
    await db.asRole(U.P1, async (s) => {
      const q = await save(s, null);
      await send(s, q.id);
      const before = await s.one<{ token: string; updated_at: string }>("select token, updated_at from quotations where id = $1", [q.id]);
      await s.as(U.M1);
      const r = await s.one<{ id: string; quotation_number: string; revision_number: number }>("select * from revise_quotation($1, $2)", [q.id, before.updated_at]);
      expect(r.revision_number).toBe(1);
      expect(r.quotation_number).not.toBe(q.quotation_number);
      const fresh = await s.one<{ status: string; token: string; total: string; created_by: string; revised_from_id: string }>(
        "select status::text, token, total::text, created_by::text, revised_from_id::text from quotations where id = $1",
        [r.id],
      );
      expect(fresh).toMatchObject({ status: "draft", total: q.total, created_by: U.M1.id, revised_from_id: q.id });
      expect(fresh.token).not.toBe(before.token);
      expect(await s.value<number>("select count(*)::int from quotation_items where quotation_id = $1", [r.id])).toBe(2);
      expect(await s.value("select status::text from quotations where id = $1", [q.id])).toBe("superseded");
      expect(await s.value<number>("select count(*)::int from quotation_follow_ups where quotation_id = $1 and status = 'pending'", [q.id])).toBe(0);
      expect(userMessage(await s.fails("select * from revise_quotation($1, null)", [q.id]))).toMatch(/already been revised/);
      expect(userMessage(await s.fails("select * from revise_quotation($1, null)", [r.id]))).toMatch(/draft is edited directly/);
      const listed = await s.one<{ superseded_by_id: string; superseded_by_number: string }>("select superseded_by_id::text, superseded_by_number from quotations_list where id = $1", [q.id]);
      expect(listed).toEqual({ superseded_by_id: r.id, superseded_by_number: r.quotation_number });

      await asService(s);
      expect(await s.value("select respond_to_quotation($1, 'accept', 'Ramesh Gupta') ->> 'outcome'", [before.token])).toBe("superseded");
    });
  });
});

describe("the public page's functions (§7.23)", () => {
  it("are callable only by the service role", async () => {
    await db.asSuper(async (s) => {
      for (const fn of ["record_quotation_view(text)", "respond_to_quotation(text,text,text,text,text,text)", "expire_lapsed_quotations(date)"]) {
        expect(await s.value(`select has_function_privilege('anon', 'public.${fn}', 'execute')`), fn).toBe(false);
        expect(await s.value(`select has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe(false);
        expect(await s.value(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe(true);
      }
    });
  });

  it("counts views, moves Sent to Viewed, and accepts once with the typed name", async () => {
    await db.asRole(U.P1, async (s) => {
      const l = await lead(s);
      const q = await save(s, null, header({ lead_id: l }));
      const token = await s.value<string>("select token from quotations where id = $1", [q.id]);
      await asService(s);
      const unsent = await s.value<{ counted: boolean }>("select record_quotation_view($1)", [token]);
      expect(unsent.counted).toBe(false);
      expect(await s.value("select respond_to_quotation($1, 'accept', 'Ramesh Gupta') ->> 'outcome'", [token])).toBe("not_open");

      await s.as(U.P1);
      await send(s, q.id);
      await asService(s);
      const v1 = await s.value<{ first_view: boolean; status: string }>("select record_quotation_view($1)", [token]);
      const v2 = await s.value<{ first_view: boolean; view_count: number }>("select record_quotation_view($1)", [token]);
      expect(v1).toMatchObject({ first_view: true, status: "viewed" });
      expect(v2).toMatchObject({ first_view: false, view_count: 2 });
      expect(await s.value("select record_quotation_view('not-a-real-token') ->> 'found'")).toBe("false");

      const missing = await s.value<{ outcome: string; field: string }>("select respond_to_quotation($1, 'accept', ' ')", [token]);
      expect(missing).toMatchObject({ outcome: "invalid", field: "name" });
      const res = await s.value<{ outcome: string; lead_won: boolean }>("select respond_to_quotation($1, 'accept', '  Ramesh   Gupta ', 'Please start in November', null, '203.0.113.7')", [token]);
      expect(res).toMatchObject({ outcome: "accepted", lead_won: true });
      const row = await s.one<{ status: string; accepted_by_name: string; response_note: string; response_ip: string; response: string }>(
        "select status::text, accepted_by_name, response_note, response_ip, response from quotations where id = $1",
        [q.id],
      );
      expect(row).toEqual({ status: "accepted", accepted_by_name: "Ramesh Gupta", response_note: "Please start in November", response_ip: "203.0.113.7", response: "accepted" });
      expect(await s.value("select status::text from leads where id = $1", [l])).toBe("won");
      expect(await s.value<number>("select count(*)::int from quotation_follow_ups where quotation_id = $1 and status = 'skipped'", [q.id])).toBe(3);
      expect(await s.value("select respond_to_quotation($1, 'decline', null, null, 'Too costly') ->> 'outcome'", [token])).toBe("already_accepted");
      expect(await s.value<number>("select count(*)::int from client_timeline_events where lead_id = $1 and event_type in ('quotation_viewed', 'quotation_accepted')", [l])).toBe(2);
    });
  });

  it("declines with a reason, and refuses expired quotations", async () => {
    await db.asRole(U.P1, async (s) => {
      const q = await save(s, null);
      await send(s, q.id);
      const token = await s.value<string>("select token from quotations where id = $1", [q.id]);
      await asService(s);
      expect(await s.value("select respond_to_quotation($1, 'decline', null, null, 'no') ->> 'field'", [token])).toBe("reason");
      expect(await s.value("select respond_to_quotation($1, 'decline', null, null, 'We are staying with our current CA') ->> 'outcome'", [token])).toBe("declined");
      expect(await s.value("select respond_to_quotation($1, 'accept', 'Ramesh Gupta') ->> 'outcome'", [token])).toBe("already_declined");
      expect(await s.value("select rejection_reason from quotations where id = $1", [q.id])).toBe("We are staying with our current CA");

      await s.as(U.P1);
      const q2 = await save(s, null);
      await send(s, q2.id);
      const t2 = await s.value<string>("select token from quotations where id = $1", [q2.id]);
      await s.as("super");
      await s.exec("update quotations set issue_date = '2026-01-01', valid_until = '2026-01-31' where id = $1", [q2.id]);
      await asService(s);
      expect(await s.value("select respond_to_quotation($1, 'accept', 'Ramesh Gupta') ->> 'outcome'", [t2])).toBe("expired");
      expect(await s.value<boolean>("select is_lapsed from quotations_list where id = $1", [q2.id])).toBe(true);
    });
  });
});

describe("expiry (§8 Quotations, nightly)", () => {
  it("expires lapsed open quotations once, skipping their follow-ups", async () => {
    await db.asRole(U.P1, async (s) => {
      const q = await save(s, null);
      await send(s, q.id);
      await asService(s);
      const tomorrowFar = "2100-01-01";
      const expired = await s.rows<{ id: string; previous_status: string }>("select id::text, previous_status::text from expire_lapsed_quotations($1)", [tomorrowFar]);
      expect(expired.find((r) => r.id === q.id)?.previous_status).toBe("sent");
      expect(await s.value("select status::text from quotations where id = $1", [q.id])).toBe("expired");
      expect(await s.value<number>("select count(*)::int from quotation_follow_ups where quotation_id = $1 and status = 'pending'", [q.id])).toBe(0);
      const again = await s.rows<{ id: string }>("select id::text from expire_lapsed_quotations($1)", [tomorrowFar]);
      expect(again.find((r) => r.id === q.id)).toBeUndefined();
    });
  });
});

describe("analytics and access (§4.1, §7.5.1, §7.5.4)", () => {
  it("lead_analytics counts conversion as won ÷ closed, for Partners and Managers only", async () => {
    await db.asRole(U.M1, async (s) => {
      const won = await lead(s);
      const lost = await lead(s);
      await s.exec("update leads set status = 'won' where id = $1", [won]);
      await s.exec("update leads set status = 'lost', lost_reason = 'Fees too high for them', lost_category = 'fees' where id = $1", [lost]);
      const a = await s.value<{ won: number; lost: number; loss_reasons: Array<{ category: string; total: number }>; by_source: unknown[] }>(
        "select lead_analytics(current_date - 1, current_date + 1)",
      );
      expect(a.won).toBeGreaterThanOrEqual(1);
      expect(a.lost).toBeGreaterThanOrEqual(1);
      expect(a.loss_reasons.find((r) => r.category === "fees")?.total).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(a.by_source)).toBe(true);
    });
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select lead_analytics(current_date - 1, current_date)"))).toMatch(/Partners and Managers/);
    });
  });

  it("Employees and portal users read no lead, quotation or acceptance row through the new views", async () => {
    for (const who of [U.E1, U.E2, U.CA]) {
      await db.asRole(who, async (s) => {
        for (const v of ["leads_list", "quotations_list", "client_acceptances_list"]) {
          const a = await s.attempt(`select count(*)::int as n from ${v}`);
          expect(a.ok ? Number((a.rows[0] as { n: number }).n) : 0, `${who.key}:${v}`).toBe(0);
        }
      });
    }
  });

  it("the acceptance register lists decisions with their conflicts and decider", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await s.value<string>(
        "insert into client_acceptances (prospect_name, conflicts_found, outcome, rationale, created_by) values ('Gupta Foods', '[{\"k\":1}]'::jsonb, 'declined', 'Audit client of a competitor group', auth.uid()) returning id",
      );
      const row = await s.one<{ conflict_count: number; decided_by_name: string; outcome: string }>(
        "select conflict_count, decided_by_name, outcome::text from client_acceptances_list where id = $1",
        [id],
      );
      expect(row).toEqual({ conflict_count: 1, decided_by_name: U.M1.fullName, outcome: "declined" });
    });
  });
});
