/**
 * API smoke against the local QA stack (README.md, docs/QA.md): what the page crawler doesn't open.
 *
 *   npx tsx scripts/local-stack/api-smoke.ts
 *
 * Every PDF and export route as a Partner (expect 200 with a PDF, spreadsheet or CSV, never HTML), the
 * portal and public quotation PDFs, a document download (the stack has no storage: expect its JSON
 * 404), money documents and firm exports as an Employee and another client's invoice as a portal user
 * (expect a refusal), and eight tabs of one Employee sending the presence heartbeat at once (expect
 * every beat answered). Exits 1 when anything is off.
 */
import { Client } from "pg";
import { dbUrl } from "../db-local";
import { APP_URL, QA_DB } from "./config";
import { sessionForKey } from "./sessions";
import { cookieHeader } from "./jwt";
import { C, fid } from "../../tests/db/fixtures";
import { REPORT_SLUGS } from "@/lib/schemas/reports";

const qid = (n: string) => fid(`qa:${n}`);

async function main() {
  const db = new Client({ connectionString: dbUrl(QA_DB) });
  await db.connect();
  const one = async (sql: string, p: unknown[] = []) => ((await db.query(sql, p)).rows[0] ?? {}) as Record<string, string>;
  const ids = {
    creditNote: (await one("select id from credit_notes order by created_at limit 1")).id,
    receipt: (await one("select id from payment_receipts order by created_at limit 1")).id,
    letter: (await one("select id from engagement_letters where client_id = $1 limit 1", [C.B])).id,
    itr: (await one("select id from itr_computations where client_id = $1 limit 1", [C.A])).id,
    group: (await one("select g.id from client_groups g where exists (select 1 from clients c where c.group_id = g.id and c.deleted_at is null) order by g.name limit 1")).id,
    token: (await one("select token from quotations where id = $1", [qid("quotation:sent")])).token,
    portalInvoice: (await one("select id from invoices where client_id = $1 and status <> 'draft' and deleted_at is null order by issue_date desc limit 1", [C.A])).id,
    document: (await one("select id from documents where client_id = $1 and deleted_at is null limit 1", [C.A])).id,
  };
  await db.end();

  const P1 = cookieHeader(sessionForKey("P1"));
  const E1 = cookieHeader(sessionForKey("E1"));
  const CA = cookieHeader(sessionForKey("CA"));
  type Check = { who: string; cookie: string | null; path: string; expect: "ok" | "refused" | "no-storage" };
  const checks: Check[] = [
    { who: "P1", cookie: P1, path: `/api/pdf/invoice/${qid("invoice:paid-tds")}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/credit-note/${ids.creditNote}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/receipt/${ids.receipt}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/quotation/${qid("quotation:sent")}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/engagement-letter/${ids.letter}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/financial-statements/${qid(`fs:${C.B}`)}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/itr/${ids.itr}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/management-representation/${qid("audit:beta-statutory")}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/compliance-report/${C.B}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/statement/client/${C.B}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/pdf/statement/group/${ids.group}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/exports/audit-checklist/${qid("audit:beta-statutory")}`, expect: "ok" },
    { who: "P1", cookie: P1, path: "/api/exports/audit-log", expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/exports/financial-statements/${qid(`fs:${C.B}`)}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/exports/gst-recon/${qid("recon:beta:092026")}`, expect: "ok" },
    { who: "P1", cookie: P1, path: "/api/exports/revenue-ledger", expect: "ok" },
    { who: "P1", cookie: P1, path: "/api/exports/sales-register", expect: "ok" },
    ...REPORT_SLUGS.map((s): Check => ({ who: "P1", cookie: P1, path: `/api/exports/reports/${s}`, expect: "ok" })),
    { who: "P1", cookie: P1, path: "/api/search?q=alpha", expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/whatsapp/vcf/${C.B}`, expect: "ok" },
    { who: "P1", cookie: P1, path: `/api/files/documents/${ids.document}`, expect: "no-storage" },
    { who: "CA", cookie: CA, path: `/api/portal/invoices/${ids.portalInvoice}/pdf`, expect: "ok" },
    { who: "anon", cookie: null, path: `/api/q/${ids.token}/pdf`, expect: "ok" },
    // Refusals: an Employee never gets money documents or firm exports; a portal user never another client's invoice.
    { who: "E1", cookie: E1, path: `/api/pdf/invoice/${qid("invoice:paid-tds")}`, expect: "refused" },
    { who: "E1", cookie: E1, path: `/api/pdf/receipt/${ids.receipt}`, expect: "refused" },
    { who: "E1", cookie: E1, path: `/api/pdf/statement/client/${C.A}`, expect: "refused" },
    { who: "E1", cookie: E1, path: "/api/exports/revenue-ledger", expect: "refused" },
    { who: "E1", cookie: E1, path: "/api/exports/audit-log", expect: "refused" },
    { who: "E1", cookie: E1, path: "/api/exports/full", expect: "refused" },
    { who: "CA", cookie: CA, path: `/api/portal/invoices/${qid("invoice:paid-tds")}/pdf`, expect: "refused" },
    { who: "anon", cookie: null, path: `/api/pdf/invoice/${qid("invoice:paid-tds")}`, expect: "refused" },
  ];

  let bad = 0;
  for (const c of checks) {
    const res = await fetch(`${APP_URL}${c.path}`, { headers: c.cookie ? { cookie: c.cookie } : {}, redirect: "manual" });
    const type = res.headers.get("content-type") ?? "";
    const body = Buffer.from(await res.arrayBuffer());
    let verdict: string;
    if (c.expect === "ok") verdict = res.status === 200 && !type.includes("text/html") && body.length > 0 ? "ok" : "BAD";
    else if (c.expect === "refused") verdict = [401, 403, 404, 307, 302].includes(res.status) ? "refused" : "BAD";
    else verdict = res.status >= 400 && res.status < 500 && type.includes("json") ? "no-storage (designed)" : res.status >= 500 ? "BAD" : "check";
    if (verdict === "BAD") bad++;
    console.log(`${verdict.padEnd(22)} ${String(res.status).padEnd(4)} ${c.who.padEnd(5)} ${c.path.slice(0, 90).padEnd(92)} ${type.split(";")[0]} ${body.length}B${verdict === "BAD" ? ` ${body.toString("utf8").slice(0, 200)}` : ""}`);
  }

  // Eight tabs of one Employee beating at once (§7.12): every beat must be answered.
  const beats = await Promise.all(
    Array.from({ length: 8 }, () => fetch(`${APP_URL}/api/presence/heartbeat`, { method: "POST", headers: { cookie: E1, "content-type": "application/json" }, body: "{}" }).then(async (r) => ({ status: r.status, body: await r.text() }))),
  );
  const failedBeats = beats.filter((b) => b.status !== 200);
  console.log(`presence: ${beats.length - failedBeats.length}/${beats.length} concurrent beats answered 200${failedBeats.length ? `; ${failedBeats.map((b) => `${b.status} ${b.body.slice(0, 120)}`).join(" | ")}` : ""}`);
  if (failedBeats.length) bad++;
  console.log(`\n${checks.length} route checks + presence; ${bad} bad`);
  process.exitCode = bad ? 1 : 0;
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
