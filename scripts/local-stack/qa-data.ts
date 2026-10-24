/**
 * The QA dataset for the local QA stack (scripts/local-stack/README.md). Local databases only.
 *
 *   npx tsx --conditions=react-server scripts/local-stack/qa-data.ts reset [dbName]
 *
 * (`stack.ts up` / `reset-data` run this for you; the react-server condition lets it use
 * server/vault.ts to seal the portal passwords with the stack's throwaway CREDENTIAL_VAULT_KEY.)
 *
 * What it builds, in order:
 *   1. resetDatabase (shim, every migration, supabase/seed/*.sql);
 *   2. the users of tests/db/fixtures.ts (P1 P2 Partners, M1 M2 Managers, E1–E4 Employees, X, D, portal
 *      users CA CB), so the staging generator has a Partner to act as;
 *   3. scripts/seed-staging.ts, unchanged, run as a child process against this database: 36 synthetic
 *      Bengaluru clients of every entity type with valid-checksum GSTINs, contacts, services with fees,
 *      the statutory calendar from the app's own engine, tasks with checklists and history, filing
 *      records, invoices and receipts with TDS;
 *   4. the rest of the fixtures (clients A, B, C and the deleted Z, with a row in nearly every table);
 *   5. this file's own layer: realistic names for the fixture cast, the staging staff folded onto the
 *      fixture logins (so P1/M1/E1 own real work), and everything else a page needs, built with the
 *      app's own domain code where it has one (ITR engine, Schedule III, GSTR-2B reconciliation, audit
 *      checklist, WhatsApp checklist, the vault).
 *
 * Every person, PAN, GSTIN, number and amount is synthetic; email addresses are on example.com or
 * taxwise.test. Refuses anything but a local database (scripts/db-local.ts) and APP_ENV=production.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { dbUrl, resetDatabase } from "../db-local";
import { createRandom, syntheticGstin, syntheticMobile, syntheticPan, syntheticTan, type Random } from "../seed-staging";
import { C, F, U, fid, fixtureSql, type UserKey } from "../../tests/db/fixtures";
import { addDays, addMonths, diffDays, financialYearOf, fyStart, previousFinancialYear, todayIST, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { invoiceTotals } from "@/lib/domain/gst";
import { formatDate } from "@/lib/format";
import { paiseToDecimalString, percentOf, toPaise } from "@/lib/domain/money";
import {
  DUE_DATE_OVERRIDE_SEED,
  DUE_DATE_RULE_SEED,
  generateEvents,
  generateOpsEvents,
  OPS_TEMPLATE_DEFAULTS,
  parseDueDateOverrideRow,
  parseDueDateRuleRow,
  toComplianceEventInsert,
  type CalendarClientProfile,
  type DueDateOverrideRow,
  type DueDateRuleRow,
  type OpsTemplate,
} from "@/lib/domain/statutory-calendar";
import { parameterInForce } from "@/lib/domain/gst";
import { ITR_RULESET_PARAM_KEY, resolveItrRuleSet } from "@/lib/domain/itr-rulesets";
import { blankItrForm, computeStored, formToStoredInputs, ItrFormSchema } from "@/lib/schemas/itr";
import { classifyLedgers, type TbLedger } from "@/lib/domain/schedule3";
import { emptyInputs, rebuildStatements, type FsInputs } from "@/lib/schemas/financial-statements";
import { mapColumns, parseGstr2b, parseRegisterRows, type SheetRow } from "@/lib/domain/gstr2b";
import { reconcile } from "@/lib/domain/recon";
import { entryData } from "@/lib/schemas/gst-recon";
import { AUDIT_STEPS, computeMateriality, stepApplies } from "@/lib/domain/audit-stages";
import { CHECKLIST_STEP_IDS, checklistToJson, type ChecklistState } from "@/lib/domain/whatsapp";
import { credentialContext } from "@/lib/schemas/registers";
import { INDEPENDENCE_QUESTIONS } from "@/lib/schemas/quality";
import { encryptSecret, keyringFromEnv } from "@/server/vault";

const ROOT = join(__dirname, "..", "..");

// =================================================================================================
// Small helpers
// =================================================================================================

type Row = Record<string, unknown>;

/** Marks a value for a jsonb column (arrays would otherwise become Postgres arrays). */
class Json {
  constructor(readonly value: unknown) {}
}
const json = (v: unknown) => new Json(v);

function sqlValue(v: unknown): unknown {
  if (v instanceof Json) return JSON.stringify(v.value);
  if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

/** Multi-row insert; a key missing from a row takes the column DEFAULT. Returns `returning` per row. */
async function ins(db: Client, table: string, rows: readonly Row[], returning = "id"): Promise<Row[]> {
  if (rows.length === 0) return [];
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const out: Row[] = [];
  const perChunk = Math.max(1, Math.floor(20000 / columns.length));
  for (let start = 0; start < rows.length; start += perChunk) {
    const params: unknown[] = [];
    const tuples = rows.slice(start, start + perChunk).map(
      (row) =>
        `(${columns
          .map((c) => {
            if (!(c in row)) return "default";
            params.push(sqlValue(row[c]));
            return `$${params.length}`;
          })
          .join(", ")})`,
    );
    const quoted = columns.map((c) => (c === "to" ? '"to"' : c)).join(", ");
    try {
      const r = await db.query(`insert into ${table.includes(".") ? table : `public.${table}`} (${quoted}) values ${tuples.join(", ")}${returning ? ` returning ${returning}` : ""}`, params);
      out.push(...(r.rows as Row[]));
    } catch (err) {
      const e = err as Error & { detail?: string; where?: string };
      throw new Error(`insert into ${table} failed: ${e.message}${e.detail ? ` (${e.detail})` : ""}${e.where ? `\n  where: ${e.where}` : ""}`);
    }
  }
  return out;
}

async function q<T extends Row = Row>(db: Client, sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    return (await db.query(sql, params.map(sqlValue))).rows as T[];
  } catch (err) {
    const e = err as Error & { detail?: string; where?: string };
    throw new Error(`${e.message}${e.detail ? ` (${e.detail})` : ""}\n  in: ${sql.slice(0, 300)}${e.where ? `\n  where: ${e.where}` : ""}`);
  }
}

/** A date at a time of day in IST, as a timestamptz literal. */
const ist = (date: DateString, time = "11:00") => `${date}T${time}:00+05:30`;
const daysAgo = (today: DateString, n: number) => addDays(today, -n);
/**
 * Something that happened earlier today (IST) at `time`; when the data is loaded before that time
 * (before office hours, say), a few minutes before the load instead, so nothing "today" is in the future.
 */
const earlierToday = (today: DateString, time: string, minutesBefore = 5): string => {
  const cap = Date.now() - minutesBefore * 60_000;
  return Date.parse(ist(today, time)) <= cap ? ist(today, time) : new Date(cap).toISOString();
};
const hex64 = (seed: string) => createHash("sha256").update(seed).digest("hex");
const money = (rupees: number) => paiseToDecimalString(toPaise(rupees));
const qid = (name: string) => fid(`qa:${name}`);

function isoWeekStart(date: DateString): DateString {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() || 7; // Mon = 1 … Sun = 7
  return addDays(date, 1 - dow);
}
function weekday(date: DateString): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
}

// =================================================================================================
// The cast: realistic names for the fixture logins (ids and emails stay as tests/db/fixtures.ts has them)
// =================================================================================================

type Person = { name: string; designation: string; department: string; phone: string; joined: DateString; membership?: string; billing: number; cost: number };

const CAST: Partial<Record<UserKey, Person>> = {
  P1: { name: "Raghavendra Bhat", designation: "Managing Partner", department: "Leadership", phone: "+91 90000 90101", joined: "2009-06-01", membership: "212345", billing: 6000, cost: 2500 },
  P2: { name: "Shalini Hegde", designation: "Partner", department: "Assurance", phone: "+91 90000 90102", joined: "2014-04-01", membership: "223456", billing: 5000, cost: 2200 },
  M1: { name: "Anita Rao", designation: "Audit Manager", department: "Assurance", phone: "+91 90000 90103", joined: "2017-07-10", billing: 3000, cost: 1300 },
  M2: { name: "Suresh Kulkarni", designation: "Tax Manager", department: "Direct tax", phone: "+91 90000 90104", joined: "2018-01-15", billing: 3000, cost: 1250 },
  E1: { name: "Ravi Kumar", designation: "Senior Accountant", department: "GST", phone: "+91 90000 90105", joined: "2020-08-03", billing: 1500, cost: 650 },
  E2: { name: "Deepa Nair", designation: "Audit Assistant", department: "Assurance", phone: "+91 90000 90106", joined: "2022-02-14", billing: 1200, cost: 500 },
  E3: { name: "Meghana Iyer", designation: "Article Assistant", department: "GST", phone: "+91 90000 90107", joined: "2024-09-02", billing: 800, cost: 250 },
  E4: { name: "Kiran Shetty", designation: "Tax Associate", department: "Direct tax", phone: "+91 90000 90108", joined: "2021-11-22", billing: 1400, cost: 600 },
  X: { name: "Arjun Patil", designation: "Accounts Executive", department: "Accounts", phone: "+91 90000 90109", joined: "2023-06-19", billing: 1000, cost: 450 },
  D: { name: "Pooja Naik", designation: "Article Assistant (left)", department: "GST", phone: "+91 90000 90110", joined: "2022-07-01", billing: 800, cost: 250 },
};
const PORTAL_CAST: Partial<Record<UserKey, string>> = { CA: "Mahesh Gowda", CB: "Sunita Reddy" };

/** The staging generator's staff (scripts/seed-staging.ts STAFF), folded onto the fixture logins. */
const STAGING_TO_FIXTURE: Record<string, UserKey> = {
  "Anita Rao": "M1",
  "Suresh Kulkarni": "M2",
  "Ravi Kumar": "E1",
  "Arjun Patil": "E1",
  "Deepa Nair": "E2",
  "Lakshmi Prasad": "E2",
  "Meghana Iyer": "E3",
  "Kiran Shetty": "E4",
};
/** Kept as a staff record without a login (People shows how that looks). */
const KEEP_WITHOUT_LOGIN = new Set(["Lakshmi Prasad"]);

const emp = (k: UserKey) => U[k].employeeId as string;
/** Every question answered no (stored as booleans; lib/schemas/quality.ts INDEPENDENCE_QUESTIONS). */
const INDEPENDENCE_ANSWERS = Object.fromEntries(INDEPENDENCE_QUESTIONS.map((x) => [x.key, false]));
const uid = (k: UserKey) => U[k].id;

// =================================================================================================
// Context shared by the sections
// =================================================================================================

type ClientInfo = {
  id: string;
  code: string;
  name: string;
  entity: string;
  ownerId: string | null;
  gstin: string | null;
  pan: string | null;
  status: string;
  stateCode: string | null;
  email: string | null;
};

type Ctx = {
  db: Client;
  today: DateString;
  fy: FinancialYear;
  rand: Random;
  clients: ClientInfo[];
  byId: Map<string, ClientInfo>;
  counts: Record<string, number>;
};

function bump(ctx: Ctx, key: string, n: number) {
  ctx.counts[key] = (ctx.counts[key] ?? 0) + n;
}

async function loadClients(ctx: Ctx) {
  const rows = await q<{ id: string; client_code: string; display_name: string; entity_type: string; owner_employee_id: string | null; gstin: string | null; pan: string | null; status: string; state_code: string | null; email: string | null }>(
    ctx.db,
    "select id, client_code::text, display_name, entity_type::text, owner_employee_id, gstin::text, pan::text, status::text, state_code, email::text from public.clients where deleted_at is null order by client_code",
  );
  ctx.clients = rows.map((r) => ({ id: r.id, code: r.client_code, name: r.display_name, entity: r.entity_type, ownerId: r.owner_employee_id, gstin: r.gstin, pan: r.pan, status: r.status, stateCode: r.state_code, email: r.email }));
  ctx.byId = new Map(ctx.clients.map((c) => [c.id, c]));
}

// =================================================================================================
// 1. People: names for the cast, the staging staff folded onto the logins
// =================================================================================================

async function people(ctx: Ctx) {
  const { db } = ctx;
  for (const [key, p] of Object.entries(CAST) as Array<[UserKey, Person]>) {
    await q(db, "update public.profiles set full_name = $2, phone = $3, icai_membership_no = $4, last_login_at = now() - interval '2 hours' where id = $1", [uid(key), p.name, p.phone, p.membership ?? null]);
    await q(db, "update auth.users set raw_user_meta_data = jsonb_build_object('full_name', $2::text) where id = $1", [uid(key), p.name]);
    await q(
      db,
      `update public.employees set full_name = $2, phone = $3, whatsapp = $3, designation = $4, department = $5, date_of_joining = $6,
         billing_rate_per_hour = $7, cost_rate_per_hour = $8 where id = $1`,
      [emp(key), p.name, p.phone, p.designation, p.department, p.joined, p.billing, p.cost],
    );
  }
  for (const [key, name] of Object.entries(PORTAL_CAST) as Array<[UserKey, string]>) {
    await q(db, "update public.profiles set full_name = $2 where id = $1", [uid(key), name]);
  }
  await q(db, "update public.profiles set preferences = jsonb_build_object('theme', 'light') where role <> 'client'");

  // The staging staff (no logins) → the fixture logins.
  const staging = await q<{ id: string; full_name: string }>(db, "select id, full_name from public.employees where email::text like '%@staff.example.com'");
  // A repair, not a reassignment: without triggers, so tasks keep their acceptance and history.
  await db.query("set local session_replication_role = replica");
  for (const s of staging) {
    const to = STAGING_TO_FIXTURE[s.full_name];
    if (!to) continue;
    const target = emp(to);
    await q(db, "update public.clients set owner_employee_id = $2 where owner_employee_id = $1", [s.id, target]);
    // A client keeps one row per person on its team.
    await q(db, "delete from public.client_team_members m where m.employee_id = $1 and exists (select 1 from public.client_team_members o where o.client_id = m.client_id and o.employee_id = $2)", [s.id, target]);
    await q(db, "update public.client_team_members set employee_id = $2 where employee_id = $1", [s.id, target]);
    await q(db, "update public.tasks set assigned_employee_id = $2 where assigned_employee_id = $1", [s.id, target]);
    await q(db, "update public.tasks set reviewer_employee_id = $2 where reviewer_employee_id = $1", [s.id, target]);
    if (KEEP_WITHOUT_LOGIN.has(s.full_name)) continue;
    await q(db, "delete from public.employees where id = $1", [s.id]);
  }
  await db.query("set local session_replication_role = origin");
  bump(ctx, "staff_folded", staging.length);
}

// =================================================================================================
// 2. The firm: settings left blank by the production seed, WhatsApp numbers, holidays
// =================================================================================================

async function firm(ctx: Ctx) {
  const { db, today } = ctx;
  await q(
    db,
    `update public.firm_settings set legal_name = 'TaxWise Consultants', tan = 'BLRT04512E', icai_frn = '014512S',
       bank_name = 'HDFC Bank', bank_account_name = 'TaxWise Consultants', bank_account_number = '50200012345678', bank_ifsc = 'HDFC0000523',
       bank_branch = 'Sadashivanagar, Bengaluru', upi_id = 'taxwise@hdfcbank', upi_payee_name = 'TaxWise Consultants',
       invoice_approval_limit = 100000, quotation_approval_limit = 150000, law_last_reviewed_at = $1, law_last_reviewed_by = $2,
       whatsapp_client_mode = true, updated_by = $2 where id = 1`,
    [ist(daysAgo(today, 18), "16:00"), uid("P1")],
  );
  const numbers = await q<{ id: string; label: string; kind: string }>(db, "select id, label, kind::text from public.firm_whatsapp_numbers order by label");
  const plan: Record<string, { label: string; number: string; employee: string | null; custodian: string | null }> = {};
  let partners = 0;
  for (const n of numbers) {
    if (n.kind === "partner") {
      partners++;
      const who: UserKey | null = partners === 1 ? "P1" : partners === 2 ? "P2" : null;
      plan[n.id] = {
        label: who ? `${CAST[who]!.name} (Partner)` : n.label,
        number: who ? (who === "P1" ? "919000090101" : "919000090102") : "",
        employee: who ? emp(who) : null,
        custodian: who ? emp(who) : null,
      };
    } else if (n.kind === "managers_office") plan[n.id] = { label: n.label, number: "919000090150", employee: null, custodian: emp("M1") };
    else plan[n.id] = { label: n.label, number: "919000090151", employee: null, custodian: emp("M2") };
  }
  for (const [id, p] of Object.entries(plan)) {
    if (!p.number) continue;
    await q(
      db,
      "update public.firm_whatsapp_numbers set label = $2, number = $3, employee_id = $4, custodian_employee_id = $5, is_active = true, two_step_verification_on = true, devices_reviewed_at = $6 where id = $1",
      [id, p.label, p.number, p.employee, p.custodian, ist(daysAgo(today, 25))],
    );
  }
  await ins(
    db,
    "holidays",
    [
      ["2026-01-15", "Makara Sankranti"],
      ["2026-01-26", "Republic Day"],
      ["2026-03-19", "Ugadi"],
      ["2026-05-01", "May Day"],
      ["2026-08-15", "Independence Day"],
      ["2026-09-14", "Ganesh Chaturthi"],
      ["2026-10-02", "Gandhi Jayanti"],
      ["2026-10-20", "Ayudha Pooja"],
      ["2026-11-10", "Balipadyami, Deepavali"],
      ["2026-12-25", "Christmas"],
    ].map(([date, name]) => ({ date, name })),
    "date",
  );
}

// =================================================================================================
// 3. Fixture clients A, B, C: real-looking identities, services, contacts, team and calendar
// =================================================================================================

async function fixtureClients(ctx: Ctx) {
  const { db, rand, today } = ctx;
  const panA = syntheticPan(rand, "P", "G");
  const panC = syntheticPan(rand, "F", "G");
  const ids = {
    A: { pan: panA, gstin: syntheticGstin("29", panA), tan: null as string | null },
    B: { pan: "AAKCB1111F", gstin: "29AAKCB1111F1Z3", tan: syntheticTan(rand, "B") },
    C: { pan: panC, gstin: syntheticGstin("29", panC), tan: syntheticTan(rand, "G") },
  };
  const detail = {
    A: {
      legal: "Mahesh Gowda", address: "No. 42, 2nd Cross, Chickpet", pincode: "560053", email: "accounts@alpha-traders.example.com", phone: "+91 90000 70001",
      notes: "Wholesale textiles. Books kept in Tally by Mahesh's son; send the purchase register request by the 5th.", priority: "high", turnover: 34_500_000, scheme: "monthly", audit: "review", dob: "1971-03-14", nature: "business",
    },
    B: {
      legal: "Beta Industries Private Limited", address: "Plot 18, KIADB Industrial Area, Peenya 2nd Stage", pincode: "560058", email: "finance@beta-industries.example.com", phone: "+91 90000 70002",
      notes: "Precision machining for auto OEMs. Statutory audit and tax audit with us since FY 2021-22; CFO prefers email over calls.", priority: "critical", turnover: 186_000_000, scheme: "monthly", audit: "yes", dob: "2011-08-22", nature: null,
    },
    C: {
      legal: "Gamma Architects LLP", address: "3rd Floor, 80 Feet Road, Indiranagar", pincode: "560038", email: "office@gamma-llp.example.com", phone: "+91 90000 70003",
      notes: "Architecture practice, four designated partners. GST quarterly (QRMP); LLP Form 8 and 11 every year.", priority: "medium", turnover: 41_000_000, scheme: "qrmp", audit: "no", dob: "2016-05-09", nature: null,
    },
  } as const;
  for (const k of ["A", "B", "C"] as const) {
    const d = detail[k];
    await q(
      db,
      `update public.clients set legal_name = $2, pan = $3, gstin = $4, tan = $5, gst_registration = 'registered', state_code = '29', address = $6, city = 'Bengaluru',
         pincode = $7, email = $8, phone = $9, whatsapp = $9, notes = $10, priority = $11, annual_turnover = $12, turnover_fy = $13, gst_scheme = $14,
         tax_audit_applicable = $15, date_of_birth_or_incorporation = $16, income_nature = $17, is_incorporated = $18, onboarded_at = $19, onboarded_by = $20, created_by = $20
       where id = $1`,
      [C[k], d.legal, ids[k].pan, ids[k].gstin, ids[k].tan, d.address, d.pincode, d.email, d.phone, d.notes, d.priority, d.turnover, previousFinancialYear(ctx.fy), d.scheme, d.audit, d.dob, d.nature, k !== "A", ist("2022-04-11"), uid("P1")],
    );
    await q(db, "update public.clients set created_at = $2 where id = $1", [C[k], ist("2022-04-08", "10:00")]);
  }
  await q(db, "update public.clients set portal_invited_at = $2, portal_last_seen_at = $3 where id = $1", [C.A, ist("2026-04-12", "18:00"), new Date(Date.now() - 3 * 3600_000).toISOString()]);
  await q(db, "update public.clients set portal_invited_at = $2, portal_last_seen_at = $3 where id = $1", [C.B, ist("2026-05-03", "11:00"), ist(daysAgo(today, 2), "21:15")]);
  await q(db, "update public.client_groups set name = 'Gowda Family Group', notes = 'Mahesh Gowda and his family businesses, billed together.' where id = $1", [fid("group:1")]);
  await q(db, "update public.clients set display_name = 'Zeta Enterprises', notes = 'Closed the business in 2025; moved to the recycle bin.' where id = $1", [C.Z]);

  // Contacts: one real person per fixture contact, plus an accountant / CFO.
  const contacts: Record<"A" | "B" | "C", Array<{ name: string; role: string; email: string; phone: string; primary: boolean; handles: string[] }>> = {
    A: [
      { name: "Mahesh Gowda", role: "Promoter", email: "mahesh@alpha-traders.example.com", phone: "+91 90000 71001", primary: true, handles: [] },
      { name: "Rohan Gowda", role: "Accountant", email: "rohan@alpha-traders.example.com", phone: "+91 90000 71002", primary: false, handles: ["gst", "bookkeeping"] },
    ],
    B: [
      { name: "Sunita Reddy", role: "Director", email: "sunita@beta-industries.example.com", phone: "+91 90000 72001", primary: true, handles: [] },
      { name: "Venkatesh Murthy", role: "CFO", email: "venkatesh@beta-industries.example.com", phone: "+91 90000 72002", primary: false, handles: ["income_tax", "audit", "tds"] },
      { name: "Harsha Pai", role: "Accountant", email: "harsha@beta-industries.example.com", phone: "+91 90000 72003", primary: false, handles: ["gst", "payroll"] },
    ],
    C: [
      { name: "Nikhil Menon", role: "Designated Partner", email: "nikhil@gamma-llp.example.com", phone: "+91 90000 73001", primary: true, handles: [] },
      { name: "Asha Kamath", role: "Accountant", email: "asha@gamma-llp.example.com", phone: "+91 90000 73002", primary: false, handles: ["gst", "tds"] },
    ],
  };
  for (const k of ["A", "B", "C"] as const) {
    const [first, ...rest] = contacts[k];
    await q(db, "update public.client_contacts set name = $2, role = $3, email = $4, phone = $5, whatsapp = $5, is_primary = true, handles = $6 where id = $1", [fid(`contact:${k}`), first.name, first.role, first.email, first.phone, first.handles]);
    await ins(db, "client_contacts", rest.map((c) => ({ id: qid(`contact:${k}:${c.name}`), client_id: C[k], name: c.name, role: c.role, email: c.email, phone: c.phone, whatsapp: c.phone, is_primary: false, handles: c.handles })));
  }

  // Services with fees (the fixture gave each a GST retainer).
  const services: Record<"A" | "B" | "C", Array<[string, string, number, string]>> = {
    A: [["income_tax", "annual", 15000, "998231"], ["bookkeeping", "monthly", 8000, "998222"]],
    B: [["income_tax", "annual", 85000, "998231"], ["tds", "quarterly", 6500, "998231"], ["audit", "annual", 225000, "998221"], ["company_law", "annual", 30000, "998231"], ["payroll", "monthly", 6000, "998222"]],
    C: [["income_tax", "annual", 40000, "998231"], ["tds", "quarterly", 4500, "998231"], ["company_law", "annual", 18000, "998231"]],
  };
  for (const k of ["A", "B", "C"] as const) {
    await q(db, "update public.client_services set agreed_fee = $2, fee_agreed_at = $3 where id = $1", [F.service(k), k === "B" ? 12000 : k === "C" ? 6000 : 5000, ist("2026-04-01")]);
    await ins(
      db,
      "client_services",
      services[k].map(([type, freq, fee, sac]) => ({
        id: qid(`service:${k}:${type}`), client_id: C[k], service_type: type, frequency: freq, agreed_fee: fee, billing_frequency: freq, sac_code: sac,
        fee_agreed_at: ist("2026-04-01"), auto_invoice: freq !== "annual", next_billing_date: freq === "annual" ? null : "2026-11-01", is_active: true,
      })),
    );
  }

  // Teams: Partner, review manager and preparers; E1 on all three.
  await ins(db, "client_team_members", [
    { client_id: C.A, employee_id: emp("P1"), team_role: "engagement_partner" },
    { client_id: C.A, employee_id: emp("M1"), team_role: "review_manager" },
    { client_id: C.B, employee_id: emp("P2"), team_role: "engagement_partner" },
    { client_id: C.B, employee_id: emp("M2"), team_role: "review_manager" },
    { client_id: C.B, employee_id: emp("E1"), team_role: "preparer" },
    { client_id: C.C, employee_id: emp("P1"), team_role: "engagement_partner" },
    { client_id: C.C, employee_id: emp("E1"), team_role: "preparer" },
  ], "");
  await q(db, "update public.client_kyc set entity_category = 'individual_proprietor', pan = $2, business_description = 'Wholesale trade in textiles and garments', verified_by = $3, verified_on = '2026-04-15', next_review_on = '2027-04-15' where client_id = $1", [C.A, ids.A.pan, uid("M1")]);
  await q(db, "update public.client_kyc set pan = $2, cin_llpin = 'U29299KA2011PTC060123', business_description = 'Precision machined components for automotive OEMs', registered_address = $3, principal_persons = $4, verified_by = $5, verified_on = '2026-05-02', next_review_on = '2027-05-02' where client_id = $1", [C.B, ids.B.pan, detail.B.address, json([{ name: "Sunita Reddy", role: "Director", din: "07123456", address: "No. 12, 4th Cross, Sadashivanagar, Bengaluru 560080" }, { name: "Prakash Reddy", role: "Director", din: "07123457", address: "No. 12, 4th Cross, Sadashivanagar, Bengaluru 560080" }]), uid("M2")]);
  await q(db, "update public.client_kyc set engagement_types = '{statutory_companies_act,tax_audit}', last_audited_fs_document_id = $2 where client_id = $1", [C.B, F.docShared("B")]);
  await q(db, "update public.client_kyc set entity_category = 'non_corporate', pan = $2, cin_llpin = 'AAH-1234', business_description = 'Architecture and interior design', verified_by = $3, verified_on = '2026-06-10', next_review_on = '2027-06-10' where client_id = $1", [C.C, ids.C.pan, uid("M1")]);
  await q(db, "update public.client_document_checklist_items set label = 'PAN card', collected = true, collected_at = now() - interval '200 days', collected_by = $1", [uid("E1")]);

  // The statutory calendar for A, B and C from the app's own engine (same as seed-staging).
  // Dates as text: node-pg would hand them over as Date objects, which the row parsers refuse.
  const ruleRows = await q<DueDateRuleRow>(db, "select *, effective_from::text as effective_from, effective_to::text as effective_to, verified_on::text as verified_on from public.due_date_rules where is_active");
  const parsedRules = ruleRows.map((r) => parseDueDateRuleRow(r)).flatMap((r) => (r.ok ? [r.value] : []));
  const overrideRows = await q<DueDateOverrideRow>(db, "select id, rule_code, period_label, original_due::text, extended_due::text, scope, source_ref from public.due_date_overrides");
  const parsedOverrides = overrideRows.map((r) => parseDueDateOverrideRow(r)).flatMap((r) => (r.ok ? [r.value] : []));
  // The same fallback as scripts/seed-staging.ts: the engine's own seed when the table can't be read.
  const rules = parsedRules.length > 0 ? parsedRules : [...DUE_DATE_RULE_SEED];
  const overrides = parsedRules.length > 0 ? parsedOverrides : [...DUE_DATE_OVERRIDE_SEED];
  const ops: OpsTemplate[] = [...OPS_TEMPLATE_DEFAULTS];
  const profiles: Record<"A" | "B" | "C", CalendarClientProfile> = {
    A: { id: C.A, serviceTypes: ["gst", "income_tax", "bookkeeping"], entityType: "proprietorship", gstScheme: "monthly", stateCode: "29", turnover: toPaise(detail.A.turnover), taxAuditApplicable: "review" },
    B: { id: C.B, serviceTypes: ["gst", "income_tax", "tds", "audit", "company_law", "payroll"], entityType: "pvt_ltd", gstScheme: "monthly", stateCode: "29", turnover: toPaise(detail.B.turnover), taxAuditApplicable: "yes" },
    C: { id: C.C, serviceTypes: ["gst", "income_tax", "tds", "company_law"], entityType: "llp", gstScheme: "qrmp", stateCode: "29", turnover: toPaise(detail.C.turnover), taxAuditApplicable: "no" },
  };
  const eventRows: Row[] = [];
  for (const k of ["A", "B", "C"] as const) {
    const seen = new Set<string>();
    const events = [...generateEvents(profiles[k], rules, overrides, { today, from: addMonths(today, -3) }), ...generateOpsEvents(profiles[k], ops, { today, from: addMonths(today, -3) })];
    for (const ev of events) {
      if (seen.has(ev.dedupeKey)) continue;
      seen.add(ev.dedupeKey);
      const row = toComplianceEventInsert(ev);
      const past = row.due_date < today;
      // Most of the past is filed; one return per client is still open and overdue.
      const overdue = past && (ev.ruleCode === "GSTR3B_MONTHLY" || ev.ruleCode === "GSTR3B_QRMP") && diffDays(today, row.due_date) < 12;
      const done = past && !overdue;
      eventRows.push({
        ...row,
        id: qid(`ce:${k}:${ev.dedupeKey}`),
        status: done ? "completed" : "pending",
        workflow_status: done ? (row.is_statutory ? "filed" : "completed") : overdue ? "documents_awaited" : "not_started",
        completed_at: done ? ist(addDays(row.due_date, -2), "17:00") : null,
      });
    }
  }
  await ins(db, "compliance_events", eventRows);
  bump(ctx, "compliance_events (A/B/C)", eventRows.length);
  // The fixture's hand-made GSTR-3B rows duplicate what the engine just generated.
  await q(db, "delete from public.compliance_events where id = any($1)", [[fid("ce:A:stat"), fid("ce:B:stat"), fid("ce:C:stat")]]);
  await q(db, "update public.compliance_events set title = 'Board meeting minutes for Q2', description = 'Draft minutes and attendance register for the September board meeting.' where id = any($1)", [[fid("ce:A:ops"), fid("ce:B:ops"), fid("ce:C:ops")]]);

  // Filing records for what the calendar says was filed (A/B/C).
  const filed = eventRows.filter((e) => e.status === "completed" && e.is_statutory);
  await ins(
    db,
    "filing_records",
    filed.map((e, i) => ({
      client_id: e.client_id, financial_year: e.financial_year, filing_type: String(e.form_code ?? e.title), period: e.filing_period, filed_on: String(e.completed_at).slice(0, 10),
      acknowledgement_no: String(e.form_code ?? "").startsWith("GSTR") ? `AA29${String(1000000 + i * 7919).slice(0, 7)}${String(i).padStart(4, "0")}` : `${String(4_000_000_000 + i * 104_729).padStart(15, "1")}`,
      compliance_event_id: e.id, shareable_with_client: true, created_by: uid("E1"),
    })),
  );
  bump(ctx, "filing_records (A/B/C)", filed.length);
}

// =================================================================================================
// 4. Work: E1's day in every state, review and decline queues, comments, dependencies
// =================================================================================================

async function work(ctx: Ctx) {
  const { db, today, fy } = ctx;
  const nextNumber = async () => (await q<{ n: string }>(db, "select public.next_document_number('task', $1::date) as n", [today]))[0].n;
  const polish: Array<[string, string, string]> = [
    [F.task("A"), "GSTR-1 and GSTR-3B for Sep 2026", "Sep 2026"],
    [F.task("B"), "TDS return (24Q and 26Q) for Q2", "Q2 2026-27"],
    [F.task("C"), "LLP Form 11 for FY 2025-26", "FY 2025-26"],
  ];
  for (const [id, title, period] of polish) await q(db, "update public.tasks set title = $2, period_label = $3, service_type = 'gst', financial_year = $4, reviewer_employee_id = $5 where id = $1", [id, title, period, fy, emp("M1")]);
  await q(db, "update public.tasks set service_type = 'tds' where id = $1", [F.task("B")]);
  await q(db, "update public.tasks set service_type = 'company_law', reviewer_employee_id = $2 where id = $1", [F.task("C"), emp("M1")]);
  await q(db, "update public.task_comments set body = 'Purchase register received on WhatsApp. Two invoices from Kaveri Traders are missing in 2B; asked the client to check with the supplier.'");
  await q(db, "update public.task_checklist_items set title = 'Download GSTR-2B and match with the purchase register', done = true, done_at = now() - interval '1 day', done_by = $1", [uid("E1")]);
  await q(db, "update public.task_automations set config = $1", [json({ title: "Monthly GST returns", lead_days: 10 })]);

  type T = { key: string; client: string; title: string; status: string; acceptance: string; due: DateString; service: string; period: string; assignee: UserKey | null; reviewer: UserKey | null; priority: string; remarks?: string; estimate?: number };
  const B = C.B, A = C.A, Cc = C.C;
  const plan: T[] = [
    { key: "e1-waiting", client: A, title: "Advance tax working for Q3 (15 Dec)", status: "not_started", acceptance: "pending", due: addDays(today, 6), service: "income_tax", period: "Q3 2026-27", assignee: "E1", reviewer: "M2", priority: "medium", estimate: 90 },
    { key: "e1-waiting-2", client: B, title: "Reconcile GSTR-2B for Sep 2026", status: "not_started", acceptance: "pending", due: addDays(today, 3), service: "gst", period: "Sep 2026", assignee: "E1", reviewer: "M1", priority: "high", estimate: 180 },
    { key: "e1-due-today", client: B, title: "GSTR-3B for Sep 2026 (payment challan)", status: "in_progress", acceptance: "accepted", due: today, service: "gst", period: "Sep 2026", assignee: "E1", reviewer: "M1", priority: "urgent", estimate: 120 },
    { key: "e1-overdue", client: Cc, title: "TDS return 26Q for Q2", status: "in_progress", acceptance: "accepted", due: daysAgo(today, 3), service: "tds", period: "Q2 2026-27", assignee: "E1", reviewer: "M2", priority: "urgent", estimate: 150 },
    { key: "e1-sent-back", client: A, title: "GSTR-3B for Sep 2026", status: "in_progress", acceptance: "accepted", due: addDays(today, 1), service: "gst", period: "Sep 2026", assignee: "E1", reviewer: "M1", priority: "high", estimate: 120 },
    { key: "e1-data-awaited", client: A, title: "ITR-3 for FY 2025-26 (belated)", status: "data_awaited", acceptance: "accepted", due: addDays(today, 7), service: "income_tax", period: "FY 2025-26", assignee: "E1", reviewer: "M2", priority: "high", remarks: "Waiting for the capital gains statement from the broker.", estimate: 240 },
    { key: "e1-review", client: B, title: "PF and ESIC returns for Sep 2026", status: "under_review", acceptance: "accepted", due: addDays(today, 2), service: "payroll", period: "Sep 2026", assignee: "E1", reviewer: "M1", priority: "medium", estimate: 60 },
    { key: "e1-hold", client: Cc, title: "LLP Form 8 for FY 2025-26", status: "on_hold", acceptance: "accepted", due: addDays(today, 6), service: "company_law", period: "FY 2025-26", assignee: "E1", reviewer: "M1", priority: "medium", estimate: 90 },
    { key: "e1-filed", client: A, title: "GSTR-1 for Sep 2026", status: "filed_done", acceptance: "accepted", due: daysAgo(today, 13), service: "gst", period: "Sep 2026", assignee: "E1", reviewer: "M1", priority: "high", estimate: 90 },
    { key: "e1-blocked", client: B, title: "Tax audit report (Form 3CA-3CD) for FY 2025-26", status: "not_started", acceptance: "accepted", due: addDays(today, 7), service: "audit", period: "FY 2025-26", assignee: "E1", reviewer: "M1", priority: "high", estimate: 1200 },
    { key: "declined", client: B, title: "Statutory audit fieldwork: inventory observation", status: "not_started", acceptance: "declined", due: addDays(today, 9), service: "audit", period: "FY 2025-26", assignee: null, reviewer: "M1", priority: "high", estimate: 360 },
    { key: "unassigned", client: Cc, title: "Professional tax return for Oct 2026", status: "not_started", acceptance: "pending", due: addDays(today, 5), service: "payroll", period: "Oct 2026", assignee: null, reviewer: null, priority: "low", estimate: 30 },
    { key: "m1-review", client: Cc, title: "GSTR-1 (IFF) for Sep 2026", status: "under_review", acceptance: "accepted", due: addDays(today, 1), service: "gst", period: "Sep 2026", assignee: "E4", reviewer: "M1", priority: "high", estimate: 60 },
  ];
  const rows: Row[] = [];
  for (const t of plan) {
    rows.push({
      id: qid(`task:${t.key}`), task_number: await nextNumber(), client_id: t.client, title: t.title, service_type: t.service, financial_year: fy, period_label: t.period, status: t.status,
      priority: t.priority, due_date: t.due, assigned_employee_id: t.assignee ? emp(t.assignee) : null, reviewer_employee_id: t.reviewer ? emp(t.reviewer) : null,
      acceptance_status: t.acceptance, accepted_at: t.acceptance === "accepted" ? ist(daysAgo(today, 6), "10:20") : null, estimated_minutes: t.estimate ?? 60,
      remarks: t.remarks ?? null, on_hold_reason: t.status === "on_hold" ? "Designated partners are revising the contribution figures; resume once the revised capital account arrives." : null,
      completion_date: t.status === "filed_done" ? ist(daysAgo(today, 14), "17:40") : null, created_by: uid("M1"), assigned_by: t.assignee ? uid("M1") : null,
      assigned_at: t.assignee ? ist(daysAgo(today, 7), "09:50") : null, created_at: ist(daysAgo(today, 8), "09:45"),
      declined_at: t.acceptance === "declined" ? ist(daysAgo(today, 1), "11:05") : null, decline_reason: t.acceptance === "declined" ? "no_capacity" : null,
      decline_note: t.acceptance === "declined" ? "Two tax audits due on 31 Oct; can take this up from 3 Nov." : null, declined_by_employee_id: t.acceptance === "declined" ? emp("E2") : null,
    });
  }
  await ins(db, "tasks", rows);
  bump(ctx, "tasks (scenario)", rows.length);

  const t = (k: string) => qid(`task:${k}`);
  await ins(db, "task_status_history", [
    { task_id: t("e1-sent-back"), from_status: "not_started", to_status: "in_progress", changed_by: uid("E1"), changed_at: ist(daysAgo(today, 5), "10:30") },
    { task_id: t("e1-sent-back"), from_status: "in_progress", to_status: "under_review", changed_by: uid("E1"), changed_at: ist(daysAgo(today, 2), "16:10") },
    { task_id: t("e1-sent-back"), from_status: "under_review", to_status: "in_progress", reason: "ITC on two invoices from Kaveri Traders isn't in GSTR-2B yet. Hold that credit back, recompute and resubmit.", changed_by: uid("M1"), changed_at: ist(daysAgo(today, 1), "12:15") },
    { task_id: t("e1-data-awaited"), from_status: "in_progress", to_status: "data_awaited", reason: "Capital gains statement and the Form 16A from the bank are pending.", changed_by: uid("E1"), changed_at: ist(daysAgo(today, 4), "15:00") },
    { task_id: t("e1-review"), from_status: "in_progress", to_status: "under_review", changed_by: uid("E1"), changed_at: ist(daysAgo(today, 1), "17:20") },
    { task_id: t("e1-hold"), from_status: "in_progress", to_status: "on_hold", reason: "Designated partners are revising the contribution figures.", changed_by: uid("M1"), changed_at: ist(daysAgo(today, 3), "11:40") },
    { task_id: t("e1-filed"), from_status: "in_progress", to_status: "under_review", changed_by: uid("E1"), changed_at: ist(daysAgo(today, 15), "15:00") },
    { task_id: t("e1-filed"), from_status: "under_review", to_status: "filed_done", changed_by: uid("M1"), changed_at: ist(daysAgo(today, 14), "17:40") },
    { task_id: t("m1-review"), from_status: "in_progress", to_status: "under_review", changed_by: uid("E4"), changed_at: ist(daysAgo(today, 0), "10:05") },
  ], "");
  const checklist = (task: string, items: Array<[string, boolean]>) =>
    items.map(([title, done], i) => ({ task_id: t(task), title, done, done_at: done ? ist(daysAgo(today, 2), "15:00") : null, done_by: done ? uid("E1") : null, sort_order: i + 1, due_offset_days: 5 - i }));
  await ins(db, "task_checklist_items", [
    ...checklist("e1-due-today", [["Sales register from the client", true], ["Match GSTR-1 with books", true], ["Compute ITC from GSTR-2B", true], ["Prepare the payment challan", false], ["File GSTR-3B with EVC", false]]),
    ...checklist("e1-sent-back", [["Download GSTR-2B", true], ["Match ITC with the purchase register", true], ["Reverse ITC not in 2B", false], ["Submit for review", false]]),
    ...checklist("e1-data-awaited", [["Form 26AS and AIS", true], ["Bank interest certificates", true], ["Capital gains statement", false], ["Form 16A from the bank", false], ["Computation and tax payable", false]]),
    ...checklist("e1-blocked", [["Trial balance from the client", false], ["Clause-wise 3CD working", false], ["Partner review", false]]),
  ], "");
  await ins(db, "task_comments", [
    { task_id: t("e1-sent-back"), author_id: uid("M1"), body: "@Ravi Kumar two Kaveri Traders invoices (KT-110, KT-111) aren't in 2B. Don't claim them this month.", mentions: [uid("E1")], created_at: ist(daysAgo(today, 1), "12:16") },
    { task_id: t("e1-sent-back"), author_id: uid("E1"), body: "Noted. Reversing ₹2,700 ITC and resubmitting by tomorrow noon.", created_at: ist(daysAgo(today, 1), "14:02") },
    { task_id: t("e1-due-today"), author_id: uid("E1"), body: "Challan amount ₹1,84,350 confirmed with Harsha. Filing after 3 pm once the payment reflects.", created_at: earlierToday(today, "10:40") },
    { task_id: t("e1-data-awaited"), author_id: uid("M2"), body: "Call Mahesh today; if the broker statement doesn't come by Monday, file on the AIS figures.", mentions: [uid("E1")], created_at: ist(daysAgo(today, 2), "18:05") },
    { task_id: t("declined"), author_id: uid("M1"), body: "Deepa can't take this before 3 Nov. Reassigning.", created_at: ist(daysAgo(today, 1), "11:30") },
  ], "");
  await ins(db, "task_dependencies", [{ task_id: t("e1-blocked"), blocker_task_id: t("e1-review") }], "");
  await ins(db, "task_attachments", [{ task_id: t("e1-sent-back"), document_id: F.docPrivate("A"), uploaded_by: uid("E1") }], "");

  // A deleted task (recycle bin).
  await q(db, "update public.tasks set deleted_at = now() - interval '3 days', deleted_by = $2, title = 'Duplicate: GSTR-1 for Aug 2026' where id = (select id from public.tasks where status = 'not_started' and deleted_at is null and id <> all($1) order by created_at limit 1)", [rows.map((r) => r.id), uid("M1")]);
}

// =================================================================================================
// 5. Time, attendance, leave, covers, presence
// =================================================================================================

async function timeAndPeople(ctx: Ctx) {
  const { db, today, rand } = ctx;
  const staffKeys: UserKey[] = ["P1", "P2", "M1", "M2", "E1", "E2", "E3", "E4", "X"];
  const holidays = new Set((await q<{ date: string }>(db, "select date::text from public.holidays")).map((r) => r.date));
  const taskRows = await q<{ id: string; client_id: string; assigned_employee_id: string | null; title: string }>(db, "select id, client_id, assigned_employee_id, title from public.tasks where deleted_at is null and status <> 'not_started'");
  const tasksOf = new Map<string, Array<{ id: string; client_id: string; title: string }>>();
  for (const t of taskRows) if (t.assigned_employee_id) tasksOf.set(t.assigned_employee_id, [...(tasksOf.get(t.assigned_employee_id) ?? []), t]);
  const anyClients = ctx.clients.filter((c) => c.status === "active");

  const entries: Row[] = [];
  const attendance: Row[] = [];
  for (const k of staffKeys) {
    const e = emp(k);
    const mine = tasksOf.get(e) ?? [];
    for (let back = 21; back >= 0; back--) {
      const day = daysAgo(today, back);
      const dow = weekday(day);
      if (dow === 7 || holidays.has(day)) continue;
      if (k === "E2" && back <= 1) continue; // on leave
      const late = rand.chance(0.12);
      const start = late ? "10:25" : rand.pick(["09:30", "09:40", "09:50", "10:00"]);
      attendance.push({ employee_id: e, date: day, status: late ? "late_login" : dow === 6 && rand.chance(0.4) ? "half_day" : "present", first_login_at: ist(day, start), last_activity_at: ist(day, back === 0 ? "11:30" : "18:40"), work_minutes: back === 0 ? 90 : rand.int(400, 520) });
      if (back === 0) continue; // today's time comes from the running timers below
      let minuteOfDay = 10 * 60;
      const blocks = rand.int(3, 5);
      for (let b = 0; b < blocks; b++) {
        const len = rand.pick([45, 60, 75, 90, 120]);
        const task = mine.length && rand.chance(0.8) ? rand.pick(mine) : null;
        const client = task ? task.client_id : rand.pick(anyClients).id;
        const h = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        entries.push({
          employee_id: e, client_id: client, task_id: task?.id ?? null, description: task ? `Worked on ${task.title}` : rand.pick(["Client call on pending documents", "Ledger scrutiny", "Notice reply research", "Internal review meeting"]),
          started_at: ist(day, h(minuteOfDay)), ended_at: ist(day, h(minuteOfDay + len)), minutes: len, billable: rand.chance(0.85), entry_source: rand.pick(["timer", "timer", "manual_range", "manual_duration"]), locked: back > 7,
        });
        minuteOfDay += len + rand.pick([0, 15, 30]);
      }
    }
  }
  // Running timers right now (E1 on today's GSTR-3B, M1 on a review).
  entries.push({ employee_id: emp("E1"), client_id: C.B, task_id: qid("task:e1-due-today"), description: "GSTR-3B for Sep 2026", started_at: new Date(Date.now() - 42 * 60_000).toISOString(), ended_at: null, minutes: null, billable: true, entry_source: "timer" });
  entries.push({ employee_id: emp("M1"), client_id: C.C, task_id: qid("task:m1-review"), description: "Review GSTR-1 (IFF)", started_at: new Date(Date.now() - 12 * 60_000).toISOString(), ended_at: null, minutes: null, billable: true, entry_source: "timer" });
  await ins(db, "time_entries", entries, "");
  bump(ctx, "time_entries", entries.length);
  await q(db, "delete from public.attendance_records a where exists (select 1 from public.attendance_records b where b.employee_id = a.employee_id and b.date = a.date and b.id < a.id)");
  await ins(db, "attendance_records", attendance.filter((a) => !(a.date === "2026-10-21" && (a.employee_id === emp("E1") || a.employee_id === emp("E2")))), "");
  bump(ctx, "attendance_records", attendance.length);

  const week = isoWeekStart(today);
  await ins(db, "timesheet_week_rows", [
    { employee_id: emp("E1"), week_start: week, client_id: C.B, task_id: qid("task:e1-due-today"), billable: true, sort_order: 1 },
    { employee_id: emp("E1"), week_start: week, client_id: C.A, task_id: qid("task:e1-sent-back"), billable: true, sort_order: 2 },
    { employee_id: emp("E1"), week_start: week, client_id: C.C, task_id: qid("task:e1-overdue"), billable: true, sort_order: 3 },
  ], "");
  await ins(db, "timesheet_week_approvals", [
    { employee_id: emp("E1"), week_start: addDays(week, -7), approved_by: uid("M1"), approved_at: ist(addDays(week, -1), "12:00"), note: "Looks right." },
    { employee_id: emp("E4"), week_start: addDays(week, -7), approved_by: uid("M2"), approved_at: ist(addDays(week, -1), "12:30") },
  ], "");

  // Leave in every state.
  await q(db, "update public.employee_leave set status = 'approved', type = 'casual', reason = 'Family function in Mysuru', decided_by = $2, decided_at = now() - interval '6 days' where employee_id = $1", [emp("E1"), uid("M1")]);
  await q(db, "update public.employee_leave set status = 'approved', type = 'casual', reason = 'Personal work', decided_by = $2, decided_at = now() - interval '5 days' where employee_id = $1", [emp("E2"), uid("M1")]);
  await ins(db, "employee_leave", [
    { employee_id: emp("E2"), start_date: daysAgo(today, 1), end_date: addDays(today, 2), type: "sick", status: "approved", reason: "Viral fever; doctor's note shared on WhatsApp.", decided_by: uid("M1"), decided_at: ist(daysAgo(today, 1), "09:10") },
    { employee_id: emp("E4"), start_date: addDays(today, 16), end_date: addDays(today, 20), type: "annual", status: "requested", reason: "Trip home to Udupi for Deepavali week." },
    { employee_id: emp("E3"), start_date: addDays(today, 4), end_date: addDays(today, 4), type: "casual", status: "requested", reason: "Articleship exam registration at ICAI Bengaluru branch.", half_day: true },
    { employee_id: emp("E1"), start_date: daysAgo(today, 40), end_date: daysAgo(today, 39), type: "sick", status: "approved", reason: "Unwell", decided_by: uid("M1"), decided_at: ist(daysAgo(today, 41)) },
    { employee_id: emp("E3"), start_date: addDays(today, 25), end_date: addDays(today, 27), type: "annual", status: "declined", reason: "Cousin's wedding", decided_by: uid("M1"), decided_at: ist(daysAgo(today, 2)), decision_note: "Tax audit filings that week; can you move it to 2 Dec?" },
    { employee_id: emp("M2"), start_date: addDays(today, 30), end_date: addDays(today, 31), type: "annual", status: "approved", reason: "Long weekend", decided_by: uid("P1"), decided_at: ist(daysAgo(today, 3)) },
    { employee_id: emp("X"), start_date: daysAgo(today, 12), end_date: daysAgo(today, 12), type: "casual", status: "cancelled", reason: "Bank work" },
  ], "");

  // Covers: E3 covers Beta Industries while E2 is on sick leave; E4 covers E2's other work.
  await ins(db, "client_covers", [
    { kind: "client", client_id: C.B, absent_employee_id: emp("E2"), cover_employee_id: emp("E3"), starts_at: ist(daysAgo(today, 1), "09:15"), ends_at: ist(addDays(today, 2), "19:00"), reason: "leave", note: "PF/ESIC and the inventory count sheet are with you till Deepa is back.", handover_note: "Inventory count sheets are in the shared drive; the CFO wants them by Tuesday.", include_vault: false, granted_by: uid("M1") },
    { kind: "person", client_id: null, absent_employee_id: emp("E2"), cover_employee_id: emp("E4"), starts_at: ist(daysAgo(today, 1), "09:20"), ends_at: ist(addDays(today, 2), "19:00"), reason: "leave", note: "Everything else of Deepa's.", include_vault: false, granted_by: uid("M1") },
  ], "");

  // Presence: who is signed in now.
  await q(db, "update public.employee_sessions set login_at = now() - interval '3 hours', last_active_at = now() - interval '4 minutes', is_active = true");
  await ins(db, "employee_sessions", (["P1", "M1", "M2", "E4", "E3"] as UserKey[]).map((k, i) => ({ employee_id: emp(k), user_id: uid(k), login_at: new Date(Date.now() - (2 + i) * 3600_000).toISOString(), last_active_at: new Date(Date.now() - (1 + i * 3) * 60_000).toISOString(), is_active: true, ip: "10.0.0.2" + i, user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/131" })), "");
  await q(db, "update public.employee_activities set activity_type = 'login', description = 'Signed in'");
  const acts: Row[] = [];
  for (const k of ["E1", "E4", "M1", "M2"] as UserKey[]) {
    acts.push(
      { employee_id: emp(k), user_id: uid(k), activity_type: "task_status_changed", description: "Moved GSTR-3B for Sep 2026 to In progress", entity_type: "task", performed_at: earlierToday(today, "10:12") },
      { employee_id: emp(k), user_id: uid(k), activity_type: "document_uploaded", description: "Uploaded the purchase register for Sep 2026", entity_type: "document", performed_at: ist(daysAgo(today, 1), "16:40") },
    );
  }
  await ins(db, "employee_activities", acts, "");
  await q(db, "update public.independence_declarations set answers = $1, details = null, declared_at = now() - interval '170 days', declared_by = (select profile_id from public.employees e where e.id = employee_id)", [json(INDEPENDENCE_ANSWERS)]);
  await ins(db, "independence_declarations", (["P1", "P2", "M1", "M2", "E4"] as UserKey[]).map((k) => ({ employee_id: emp(k), financial_year: ctx.fy, answers: json(INDEPENDENCE_ANSWERS), declared_at: ist("2026-04-08"), declared_by: uid(k) })), "");
}

// =================================================================================================
// 6. Growth: leads in every stage, quotations in every status (one with a live public link)
// =================================================================================================

async function growth(ctx: Ctx) {
  const { db, today } = ctx;
  await q(db, "update public.leads set name = 'Prakash Joshi', company = 'Joshi Organics LLP', phone = '+91 90000 74001', source = 'referral', source_detail = 'Referred by Mahesh Gowda', status = 'contacted', services_required = '{gst,income_tax}', requirement_notes = 'New LLP, needs GST registration and monthly returns.', assigned_to = $1, next_follow_up_at = now() + interval '1 day' where lead_number = 'L-9001'", [emp("M1")]);
  await q(db, "update public.leads set name = 'Farah Sheikh', company = 'Sheikh Dental Clinic', phone = '+91 90000 74002', source = 'website', status = 'new_lead', services_required = '{income_tax,bookkeeping}', requirement_notes = 'Dentist, two clinics; wants bookkeeping and ITR.', assigned_to = $1 where lead_number = 'L-9002'", [emp("M2")]);
  type L = { key: string; name: string; company: string | null; status: string; source: string; value: number; services: string[]; assignee: UserKey; followUp: number | null; notes: string; lost?: [string, string] };
  const leads: L[] = [
    { key: "qreq", name: "Vivek Acharya", company: "Acharya Precision Tools Pvt Ltd", status: "quotation_requested", source: "existing_client", value: 240000, services: ["audit", "income_tax", "company_law"], assignee: "P2", followUp: 2, notes: "Shifting their statutory audit from the current auditor; wants a fee quote by next week." },
    { key: "fu", name: "Nandini Rao", company: "Nandini Silk House", status: "follow_up_required", source: "walk_in", value: 60000, services: ["gst", "bookkeeping"], assignee: "M1", followUp: -2, notes: "Asked to call back after the festive sale; follow-up is overdue." },
    { key: "revert", name: "Girish Hegde", company: null, status: "client_will_revert", source: "referral", value: 18000, services: ["income_tax"], assignee: "M2", followUp: 5, notes: "Salaried with capital gains; comparing two quotes." },
    { key: "proposal", name: "Chetan Naidu", company: "Naidu Logistics Pvt Ltd", status: "proposal_sent", source: "cold_call", value: 180000, services: ["gst", "tds", "payroll"], assignee: "P1", followUp: 3, notes: "Quotation sent; they have 14 trucks and two GST registrations." },
    { key: "nego", name: "Shilpa Kamath", company: "Kamath Hospitality LLP", status: "negotiation", source: "social_media", value: 320000, services: ["audit", "gst", "bookkeeping"], assignee: "P1", followUp: 1, notes: "Wants 10% off the bookkeeping fee for a two-year commitment." },
    { key: "won", name: "Arun Desai", company: "Desai Interiors", status: "won", source: "referral", value: 75000, services: ["gst", "income_tax"], assignee: "M1", followUp: null, notes: "Accepted the quotation; onboarding in progress." },
    { key: "lost", name: "Divya Shenoy", company: "Shenoy Opticals", status: "lost", source: "whatsapp", value: 40000, services: ["gst"], assignee: "M2", followUp: null, notes: "Went with a firm closer to Jayanagar.", lost: ["competitor", "Chose a firm closer to their shop; fee was not the issue."] },
    { key: "new2", name: "Pavan Reddy", company: "Reddy Agro Foods Pvt Ltd", status: "new_lead", source: "website", value: 150000, services: ["incorporation", "gst"], assignee: "M1", followUp: 0, notes: "Wants to incorporate a food-processing company in Hoskote." },
  ];
  const leadRows = leads.map((l) => ({
    id: qid(`lead:${l.key}`), name: l.name, company: l.company, email: `${l.name.split(" ")[0].toLowerCase()}@${(l.company ?? l.name).toLowerCase().replace(/[^a-z]+/g, "-")}.example.com`, phone: syntheticMobile(74100 + leads.indexOf(l)),
    services_required: l.services, requirement_notes: l.notes, source: l.source, status: l.status, estimated_value: l.value, assigned_to: emp(l.assignee),
    next_follow_up_at: l.followUp === null ? null : ist(addDays(today, l.followUp), "11:00"), lost_reason: l.lost?.[1] ?? null, lost_category: l.lost?.[0] ?? null,
    closed_at: l.status === "won" || l.status === "lost" ? ist(daysAgo(today, 4)) : null, status_changed_at: ist(daysAgo(today, 4)), created_by: uid("P1"), created_at: ist(daysAgo(today, 30 - leads.indexOf(l) * 3)),
  }));
  await ins(db, "leads", leadRows);
  bump(ctx, "leads", leadRows.length + 2);
  await q(db, "update public.leads set deleted_at = now() - interval '2 days', deleted_by = $1 where id = $2", [uid("P1"), qid("lead:new2")]);
  await ins(db, "client_timeline_events", [
    { lead_id: qid("lead:nego"), event_type: "lead_note", title: "Call with Shilpa: asked for a two-year fee lock", performed_by: uid("P1"), created_at: ist(daysAgo(today, 1), "15:30") },
    { lead_id: qid("lead:proposal"), event_type: "quotation_sent", title: "Quotation sent: ₹1,80,000 a year", performed_by: uid("P1"), created_at: ist(daysAgo(today, 6)) },
    { lead_id: qid("lead:fu"), event_type: "lead_note", title: "Nandini asked us to call after the festive sale", performed_by: uid("M1"), created_at: ist(daysAgo(today, 9)) },
  ], "");
  await q(db, "update public.client_acceptances set prospect_name = 'Acharya Precision Tools Pvt Ltd', lead_id = $1, outcome = 'pending', related_parties = '{Vivek Acharya,Acharya Tooling LLP}' where client_id = $2", [qid("lead:qreq"), C.A]);
  await q(db, "update public.client_acceptances set prospect_name = 'Beta Industries Private Limited', outcome = 'accepted', conflicts_found = '[]', rationale = 'No conflicts; independence confirmed by the engagement team.', decided_by = $1, decided_at = '2026-04-05' where client_id = $2", [uid("P2"), C.B]);
  await q(db, "update public.client_acceptances set prospect_name = 'Gamma Architects LLP', outcome = 'accepted', conflicts_found = '[]', rationale = 'Continuing client.', decided_by = $1, decided_at = '2026-04-06' where client_id = $2", [uid("P1"), C.C]);

  // Quotations: polish the fixture ones, then one per status.
  const firm = (await q<{ quotation_terms: string }>(db, "select quotation_terms from public.firm_settings where id = 1"))[0];
  const qnum = async (d: DateString) => (await q<{ n: string }>(db, "select public.next_document_number('quotation', $1::date) as n", [d]))[0].n;
  await q(db, "update public.quotations set client_name = c.display_name, client_email = c.email, client_company = c.legal_name, place_of_supply_code = '29', status = 'sent', sent_at = now() - interval '20 days', approved_by = $1, terms = $2 from public.clients c where c.id = quotations.client_id", [uid("P1"), firm.quotation_terms]);
  await q(db, "update public.quotation_items set description = 'Annual GST compliance retainer (12 months)', service_type = 'gst', frequency = 'annual', quantity = 1, tax_rate = 18");
  await q(db, "update public.quotation_email_logs set \"to\" = 'accounts@alpha-traders.example.com', subject = 'Quotation from TaxWise Consultants'");
  type Qt = { key: string; status: string; lead?: string; client?: string; name: string; email: string; company: string | null; issue: number; lines: Array<[string, string, string, number]>; token?: boolean; views?: number; extra?: Row };
  const quotes: Qt[] = [
    { key: "draft", status: "draft", lead: "qreq", name: "Vivek Acharya", email: "vivek@acharya-precision-tools-pvt-ltd.example.com", company: "Acharya Precision Tools Pvt Ltd", issue: 0, lines: [["Statutory audit, FY 2026-27", "audit", "annual", 150000], ["Income-tax return and tax audit", "income_tax", "annual", 60000], ["ROC annual filings", "company_law", "annual", 30000]] },
    { key: "pending", status: "pending_approval", lead: "nego", name: "Shilpa Kamath", email: "shilpa@kamath-hospitality-llp.example.com", company: "Kamath Hospitality LLP", issue: 1, lines: [["Accounting and bookkeeping (12 months)", "bookkeeping", "monthly", 180000], ["GST return filing (12 months)", "gst", "monthly", 72000], ["Tax audit, FY 2026-27", "audit", "annual", 68000]], extra: { approval_requested_at: ist(daysAgo(today, 1), "16:00"), approval_requested_by: uid("M1") } },
    { key: "approved", status: "approved", lead: "revert", name: "Girish Hegde", email: "girish@girish-hegde.example.com", company: null, issue: 2, lines: [["Income-tax return with capital gains, FY 2025-26", "income_tax", "one_time", 18000]], extra: { approved_by: uid("P2"), approved_at: ist(daysAgo(today, 1), "10:00"), approval_note: "Fine at this fee." } },
    { key: "sent", status: "sent", lead: "proposal", name: "Chetan Naidu", email: "chetan@naidu-logistics-pvt-ltd.example.com", company: "Naidu Logistics Pvt Ltd", issue: 6, token: true, lines: [["GST returns for two registrations (12 months)", "gst", "monthly", 96000], ["TDS returns (4 quarters)", "tds", "quarterly", 36000], ["Payroll compliance (12 months)", "payroll", "monthly", 48000]], extra: { sent_at: ist(daysAgo(today, 6), "15:00"), last_sent_at: ist(daysAgo(today, 6), "15:00") } },
    { key: "viewed", status: "viewed", client: C.C, name: "Nikhil Menon", email: "nikhil@gamma-llp.example.com", company: "Gamma Architects LLP", issue: 4, token: true, views: 3, lines: [["Internal audit, H2 FY 2026-27", "audit", "one_time", 90000]], extra: { sent_at: ist(daysAgo(today, 4), "12:00"), first_viewed_at: ist(daysAgo(today, 3), "20:10"), last_viewed_at: earlierToday(today, "09:05") } },
    { key: "accepted", status: "accepted", lead: "won", name: "Arun Desai", email: "arun@desai-interiors.example.com", company: "Desai Interiors", issue: 12, token: true, views: 2, lines: [["GST return filing (12 months)", "gst", "monthly", 45000], ["Income-tax return", "income_tax", "annual", 30000]], extra: { sent_at: ist(daysAgo(today, 12)), first_viewed_at: ist(daysAgo(today, 11)), last_viewed_at: ist(daysAgo(today, 5)), responded_at: ist(daysAgo(today, 5), "18:30"), response: "accepted", accepted_by_name: "Arun Desai", response_ip: "103.21.4.18" } },
    { key: "rejected", status: "rejected", lead: "lost", name: "Divya Shenoy", email: "divya@shenoy-opticals.example.com", company: "Shenoy Opticals", issue: 20, token: true, views: 1, lines: [["GST return filing (12 months)", "gst", "monthly", 40000]], extra: { sent_at: ist(daysAgo(today, 20)), first_viewed_at: ist(daysAgo(today, 19)), last_viewed_at: ist(daysAgo(today, 19)), responded_at: ist(daysAgo(today, 16)), response: "rejected", rejection_reason: "Going with a firm closer to our shop." } },
    { key: "expired", status: "expired", client: C.A, name: "Mahesh Gowda", email: "mahesh@alpha-traders.example.com", company: "Alpha Traders", issue: 50, token: true, lines: [["Tax audit, FY 2025-26", "audit", "one_time", 35000]], extra: { sent_at: ist(daysAgo(today, 50)), expired_at: ist(daysAgo(today, 20)) } },
  ];
  const qrows: Row[] = [];
  const itemRows: Row[] = [];
  for (const qt of quotes) {
    const id = qid(`quotation:${qt.key}`);
    const issue = daysAgo(today, qt.issue);
    let sub = 0;
    let tax = 0;
    qt.lines.forEach(([description, service, frequency, fee], i) => {
      const lineTax = percentOf(toPaise(fee), 18);
      sub += toPaise(fee);
      tax += lineTax;
      itemRows.push({ quotation_id: id, description, service_type: service, frequency, quantity: 1, unit_price: fee, tax_rate: 18, tax_amount: paiseToDecimalString(lineTax), total: paiseToDecimalString(toPaise(fee) + lineTax), sort_order: i + 1 });
    });
    qrows.push({
      id, quotation_number: await qnum(issue), lead_id: qt.lead ? qid(`lead:${qt.lead}`) : null, client_id: qt.client ?? null, client_name: qt.name, client_email: qt.email, client_company: qt.company,
      place_of_supply_code: "29", issue_date: issue, valid_until: addDays(issue, 30), status: qt.status, terms: firm.quotation_terms, notes: "Fees are exclusive of GST at 18%.",
      subtotal: paiseToDecimalString(sub), tax_amount: paiseToDecimalString(tax), total: paiseToDecimalString(sub + tax), ...(qt.token ? { token: hex64(`qa-quotation-token:${qt.key}`) } : {}),
      view_count: qt.views ?? 0, created_by: uid(qt.key === "pending" ? "M1" : "P1"), created_at: ist(issue, "10:00"), ...(qt.extra ?? {}),
    });
  }
  await ins(db, "quotations", qrows);
  await ins(db, "quotation_items", itemRows, "");
  bump(ctx, "quotations", qrows.length + 3);
  // A revision: the expired quotation superseded by a new draft.
  await q(db, "update public.quotations set status = 'superseded' where id = $1", [qid("quotation:expired")]);
  const rev = qid("quotation:expired-rev");
  await ins(db, "quotations", [{ id: rev, quotation_number: await qnum(today), client_id: C.A, client_name: "Mahesh Gowda", client_email: "mahesh@alpha-traders.example.com", client_company: "Alpha Traders", place_of_supply_code: "29", issue_date: today, valid_until: addDays(today, 30), status: "draft", subtotal: "38000.00", tax_amount: "6840.00", total: "44840.00", revised_from_id: qid("quotation:expired"), revision_number: 1, terms: firm.quotation_terms, created_by: uid("P1") }]);
  await ins(db, "quotation_items", [{ quotation_id: rev, description: "Tax audit, FY 2025-26 (revised scope)", service_type: "audit", frequency: "one_time", quantity: 1, unit_price: 38000, tax_rate: 18, tax_amount: "6840.00", total: "44840.00", sort_order: 1 }], "");
  await ins(db, "quotation_email_logs", [
    { quotation_id: qid("quotation:sent"), channel: "email", email_type: "initial", to: "chetan@naidu-logistics-pvt-ltd.example.com", subject: "Quotation from TaxWise Consultants", status: "delivered", sent_at: ist(daysAgo(today, 6), "15:00"), delivered_at: ist(daysAgo(today, 6), "15:01") },
    { quotation_id: qid("quotation:sent"), channel: "email", email_type: "follow_up_3", to: "chetan@naidu-logistics-pvt-ltd.example.com", subject: "Following up on our quotation", status: "sent", sent_at: ist(daysAgo(today, 3), "10:00") },
    { quotation_id: qid("quotation:viewed"), channel: "email", email_type: "initial", to: "nikhil@gamma-llp.example.com", subject: "Quotation for internal audit", status: "opened", sent_at: ist(daysAgo(today, 4)), opened_at: ist(daysAgo(today, 3), "20:09") },
  ], "");
  await ins(db, "quotation_follow_ups", [
    { quotation_id: qid("quotation:sent"), follow_up_day: 3, scheduled_at: ist(daysAgo(today, 3), "10:00"), sent_at: ist(daysAgo(today, 3), "10:00"), status: "sent", channel: "email" },
    { quotation_id: qid("quotation:sent"), follow_up_day: 7, scheduled_at: ist(addDays(today, 1), "10:00"), status: "pending", channel: "email" },
    { quotation_id: qid("quotation:viewed"), follow_up_day: 7, scheduled_at: ist(addDays(today, 3), "10:00"), status: "pending", channel: "whatsapp_handoff" },
  ], "");
}

// =================================================================================================
// 7. Money: approvals, disputes, credit notes, reminders, retainer drafts, TDS credits
// =================================================================================================

async function moneySide(ctx: Ctx) {
  const { db, today } = ctx;
  // The fixture invoices: lines and a billing period on the sent ones.
  for (const k of ["A", "B", "C"] as const) {
    // The fixture issued these without lines; add the line it billed (bypassing the issued-invoice
    // guard, which is right for the app and wrong for repairing a fixture).
    await db.query("set local session_replication_role = replica");
    await ins(db, "invoice_items", [{ invoice_id: F.invoiceSent(k), description: "GST return filing for Aug 2026", service_type: "gst", sac_code: "998231", quantity: 1, rate: 5000, amount: 5000, tax_rate: 18, sort_order: 1, client_service_id: F.service(k) }], "");
    await q(db, "update public.invoices i set client_address_snapshot = c.address || ', ' || c.city || ' ' || c.pincode, client_name_snapshot = c.legal_name, client_gstin_snapshot = c.gstin, client_state_snapshot = '29' from public.clients c where c.id = i.client_id and i.client_id = $1", [C[k]]);
    await db.query("set local session_replication_role = origin");
    await q(db, "update public.invoice_items set description = 'GST return filing for Sep 2026', service_type = 'gst' where invoice_id = $1", [F.invoiceDraft(k)]);
  }
  await q(db, "update public.invoice_follow_ups set notes = 'Spoke to the accountant; payment promised after the month-end collections.', promised_payment_date = $1", [addDays(today, 5)]);
  await q(db, "update public.payment_receipts set reference = 'UPI' || substr(md5(receipt_number), 1, 12), deposited_to = 'HDFC current account', notes = 'Part payment' where receipt_number like 'TW-R/26-27/90%'");
  await q(db, "update public.credit_notes set reason = 'Goodwill: one month''s late fee on GSTR-3B was our delay', reason_code = 'goodwill', issue_date = $1 where credit_note_number like 'TW-CN/26-27/90%'", [daysAgo(today, 20)]);

  const firmRow = (await q<{ state_code: string; gstin: string; invoice_terms: string }>(db, "select state_code, gstin::text, invoice_terms from public.firm_settings where id = 1"))[0];
  const addressOf = new Map(
    (await q<{ id: string; address: string | null; city: string | null; pincode: string | null }>(db, "select id, address, city, pincode from public.clients where address is not null")).map((c) => [c.id, `${c.address}, ${c.city ?? "Bengaluru"} ${c.pincode ?? ""}`.trim()]),
  );
  const makeInvoice = async (key: string, client: ClientInfo, opts: { issue: DateString; status: string; lines: Array<[string, string, string, number]>; period: string; extra?: Row; createdBy?: UserKey }) => {
    const pos = client.stateCode ?? "29";
    const totals = invoiceTotals(opts.lines.map(([, , , fee]) => ({ quantity: 1, ratePaise: toPaise(fee), taxRate: 18, isReimbursement: false })), pos, firmRow.state_code);
    const id = qid(`invoice:${key}`);
    await ins(db, "invoices", [{
      id, client_id: client.id, issue_date: opts.issue, due_date: addDays(opts.issue, 15), status: "draft", client_name_snapshot: client.name, client_address_snapshot: addressOf.get(client.id) ?? null, client_gstin_snapshot: client.gstin, place_of_supply_code: pos,
      client_state_snapshot: pos, firm_gstin_snapshot: firmRow.gstin, taxable_amount: paiseToDecimalString(totals.taxablePaise), cgst_amount: paiseToDecimalString(totals.cgstPaise), sgst_amount: paiseToDecimalString(totals.sgstPaise),
      igst_amount: paiseToDecimalString(totals.igstPaise), reimbursement_amount: "0.00", round_off: paiseToDecimalString(totals.roundOffPaise), total_amount: paiseToDecimalString(totals.totalPaise),
      outstanding_amount: paiseToDecimalString(totals.totalPaise), billing_period_label: opts.period, service_type: opts.lines[0][1], terms: firmRow.invoice_terms, created_by: uid(opts.createdBy ?? "M1"), created_at: ist(opts.issue, "10:30"),
    }]);
    await ins(db, "invoice_items", opts.lines.map(([description, service, sac, fee], i) => ({ invoice_id: id, description, service_type: service, sac_code: sac, quantity: 1, rate: fee, amount: paiseToDecimalString(totals.lines[i].amountPaise), tax_rate: 18, sort_order: i + 1 })), "");
    if (opts.status !== "draft") {
      const issued = opts.status !== "awaiting_approval";
      const number = issued ? (await q<{ n: string }>(db, "select public.next_document_number('invoice', $1::date) as n", [opts.issue]))[0].n : null;
      const sets = Object.entries({ status: opts.status, ...(issued ? { invoice_number: number } : {}), ...(opts.extra ?? {}) });
      await q(db, `update public.invoices set ${sets.map(([k], i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [id, ...sets.map(([, v]) => v)]);
    }
    return { id, totalPaise: totals.totalPaise, taxablePaise: totals.taxablePaise };
  };
  const big = ctx.clients.filter((c) => c.status === "active" && c.entity === "pvt_ltd" && c.id !== C.B);
  const bClient = ctx.byId.get(C.B)!;
  const cClient = ctx.byId.get(C.C)!;
  // Awaiting approval (above the ₹1,00,000 limit), submitted by M1.
  await makeInvoice("awaiting", bClient, { issue: today, status: "awaiting_approval", period: "FY 2025-26", lines: [["Statutory audit fee, FY 2025-26", "audit", "998221", 150000], ["Tax audit fee, FY 2025-26", "audit", "998221", 75000]], extra: { requires_approval: true, submitted_at: earlierToday(today, "10:45") } });
  await makeInvoice("awaiting-2", big[0] ?? cClient, { issue: daysAgo(today, 1), status: "awaiting_approval", period: "H1 FY 2026-27", lines: [["Internal audit, H1 FY 2026-27", "audit", "998221", 120000]], extra: { requires_approval: true, submitted_at: ist(daysAgo(today, 1), "17:10") } });
  // Overdue and disputed.
  const disputed = await makeInvoice("disputed", cClient, { issue: daysAgo(today, 48), status: "sent", period: "Aug 2026", lines: [["LLP annual filing (Form 8 and Form 11)", "company_law", "998231", 18000]], extra: { sent_at: ist(daysAgo(today, 48), "15:00"), sent_channels: ["email"], issued_at: ist(daysAgo(today, 48), "15:00"), issued_by: uid("P1") } });
  await q(db, "update public.invoices set status = 'disputed', disputed_reason = 'Client says Form 11 was quoted inside the annual fee.', disputed_at = now() - interval '9 days', disputed_by = $2 where id = $1", [disputed.id, uid("P1")]);
  // A paid invoice with TDS and a credit note on it.
  const paid = await makeInvoice("paid-tds", bClient, { issue: daysAgo(today, 40), status: "sent", period: "Q2 2026-27", lines: [["TDS returns for Q2 2026-27", "tds", "998231", 6500], ["Payroll compliance for Jul–Sep 2026", "payroll", "998222", 18000]], extra: { sent_at: ist(daysAgo(today, 40), "15:00"), sent_channels: ["email"], issued_at: ist(daysAgo(today, 40), "15:00"), issued_by: uid("P2") } });
  const tds = percentOf(paid.taxablePaise, 10);
  const rnum = async (d: DateString) => (await q<{ n: string }>(db, "select public.next_document_number('receipt', $1::date) as n", [d]))[0].n;
  await ins(db, "payment_receipts", [{ receipt_number: await rnum(daysAgo(today, 25)), invoice_id: paid.id, payment_date: daysAgo(today, 25), amount_received: paiseToDecimalString(paid.totalPaise - tds - 50000), tds_amount: paiseToDecimalString(tds), tds_section: "194J", method: "bank_transfer", reference: "UTR428817263544", deposited_to: "HDFC current account", recorded_by: uid("M2"), tds_status: "reflected", tds_quarter: "Q3 2026-27", deductor_tan: "BLRB12345C", tds_reflected_on: daysAgo(today, 5) }], "");
  const cn = await q<{ n: string }>(db, "select public.next_document_number('credit_note', $1::date) as n", [daysAgo(today, 10)]);
  await ins(db, "credit_notes", [{ credit_note_number: cn[0].n, invoice_id: paid.id, client_id: C.B, reason_code: "fee_reduction", reason: "Payroll fee for July reduced: only 9 employees on rolls that month.", reduces_gst: true, taxable_amount: "423.73", tax_rate: 18, cgst_amount: "38.14", sgst_amount: "38.13", igst_amount: "0", total_amount: "500.00", place_of_supply_code: "29", issue_date: daysAgo(today, 10), issued_by: uid("P2") }], "");
  // Reminders and follow-ups on what's open and overdue.
  const overdue = await q<{ id: string; client_id: string; due_date: string }>(db, "select id, client_id, due_date::text from public.invoices where status in ('sent','partially_paid') and due_date < $1 and deleted_at is null order by due_date limit 8", [today]);
  await ins(db, "invoice_reminders", overdue.flatMap((o, i) => [
    { invoice_id: o.id, kind: "before_due", scheduled_for: ist(addDays(o.due_date, -3), "09:00"), channel: "email", sent_at: ist(addDays(o.due_date, -3), "09:00"), status: "sent", reminder_key: "before_due:3", offset_days: 3, due_date: o.due_date },
    { invoice_id: o.id, kind: "after_due", scheduled_for: ist(addDays(o.due_date, 7), "09:00"), channel: i % 2 ? "email" : "whatsapp_handoff", status: i % 2 ? "sent" : "handoff_pending", sent_at: i % 2 ? ist(addDays(o.due_date, 7), "09:00") : null, reminder_key: "after_due:7", offset_days: 7, due_date: o.due_date, owner_user_id: uid("M1") },
  ]), "");
  await ins(db, "invoice_follow_ups", overdue.slice(0, 4).map((o, i) => ({ invoice_id: o.id, channel: ["call", "whatsapp", "email", "visit"][i], notes: ["Accountant says the cheque is signed; collect on Monday.", "Shared the invoice again on WhatsApp.", "Sent a statement of account.", "Met the CFO at the office; will pay after the board approves."][i], promised_payment_date: addDays(today, 2 + i), next_follow_up_at: ist(addDays(today, 3 + i), "11:00"), by_user: uid(i % 2 ? "M2" : "M1") })), "");

  // Retainer drafts: this month's run made drafts from the auto-invoice services.
  const runId = qid("retainer-run:today");
  const services = await q<{ id: string; client_id: string; service_type: string; agreed_fee: string; sac_code: string | null }>(
    db,
    "select s.id, s.client_id, s.service_type::text, s.agreed_fee::text, s.sac_code from public.client_services s join public.clients c on c.id = s.client_id where s.auto_invoice and s.is_active and c.deleted_at is null and c.status = 'active' and s.agreed_fee > 0 order by c.client_code limit 4",
  );
  await ins(db, "retainer_runs", [{ id: runId, run_date: addDays(today, -23), started_at: ist(addDays(today, -23), "06:00"), finished_at: ist(addDays(today, -23), "06:01"), counts: { engagements_checked: 14, already_billed: 1, skipped_not_enabled: 6, skipped_client_inactive_or_on_hold: 2, skipped_no_agreed_fee: 1 }, capped: json([]), errors: json([]), drafts_created: services.length }], "");
  let total = 0;
  for (const s of services) {
    const client = ctx.byId.get(s.client_id);
    if (!client) continue;
    const inv = await makeInvoice(`retainer:${s.id}`, client, { issue: addDays(today, -23), status: "draft", period: "Oct 2026", lines: [[`Retainer for Oct 2026: ${s.service_type.replace("_", " ")}`, s.service_type, s.sac_code ?? "998231", Number(s.agreed_fee)]], createdBy: "P1" });
    await q(db, "update public.invoices set client_service_id = $2 where id = $1", [inv.id, s.id]);
    await ins(db, "retainer_drafts", [{ run_id: runId, invoice_id: inv.id, client_service_id: s.id, billing_date: addDays(today, -23), period_label: "Oct 2026" }], "");
    total += inv.totalPaise;
  }
  await q(db, "update public.retainer_runs set drafts_total = $2 where id = $1", [runId, paiseToDecimalString(total)]);

  // TDS credits: a 26AS import matched against receipts with TDS.
  const tdsReceipts = await q<{ id: string; tds_amount: string; deductor_tan: string | null; payment_date: string; client_id: string; client_name: string }>(
    db,
    "select r.id, r.tds_amount::text, r.deductor_tan::text, r.payment_date::text, i.client_id, c.display_name as client_name from public.payment_receipts r join public.invoices i on i.id = r.invoice_id join public.clients c on c.id = i.client_id where r.tds_amount > 0 order by r.payment_date limit 12",
  );
  const importId = qid("tds-import:26as");
  await ins(db, "tds_statement_imports", [{ id: importId, financial_year: ctx.fy, source: "26as", file_name: "26AS_AAXFT1811B_2027.txt", rows_total: tdsReceipts.length + 2, matched: Math.max(0, tdsReceipts.length - 2), amount_mismatches: 1, unmatched: 3, imported_by: uid("M2") }], "");
  await ins(db, "tds_statement_entries", [
    ...tdsReceipts.map((r, i) => ({
      financial_year: ctx.fy, quarter: "Q2", source: "26as", deductor_tan: r.deductor_tan ?? "BLRX00000X", deductor_name: r.client_name, section: "194J", transaction_date: r.payment_date, amount_paid: money(Number(r.tds_amount) * 10),
      tds_amount: i === 1 ? money(Number(r.tds_amount) - 100) : r.tds_amount, import_batch_id: importId, matched_receipt_id: i < tdsReceipts.length - 2 ? r.id : null, matched_at: i < tdsReceipts.length - 2 ? ist(daysAgo(today, 5)) : null,
      match_status: i === 1 ? "amount_mismatch" : i < tdsReceipts.length - 2 ? "matched" : "unmatched", client_id: r.client_id, booking_status: "F", created_by: uid("M2"),
    })),
    { financial_year: ctx.fy, quarter: "Q2", source: "26as", deductor_tan: "BLRK54321D", deductor_name: "Kaveri Agencies", section: "194J", transaction_date: daysAgo(today, 60), amount_paid: "25000.00", tds_amount: "2500.00", import_batch_id: importId, match_status: "unmatched", booking_status: "F", created_by: uid("M2") },
    { financial_year: ctx.fy, quarter: "Q2", source: "26as", deductor_tan: "BLRS11223E", deductor_name: "Sri Lakshmi Steel Traders", section: "194J", transaction_date: daysAgo(today, 70), amount_paid: "12000.00", tds_amount: "1200.00", import_batch_id: importId, match_status: "unmatched", booking_status: "U", created_by: uid("M2") },
  ], "");
  await q(db, "update public.tds_statement_entries set deductor_name = 'Gamma Architects LLP', deductor_tan = 'BLRG12345A', section = '194J', quarter = 'Q1', match_status = 'unmatched' where import_batch_id is null");
  await q(db, "update public.portal_payment_claims set reference = 'UPI 4281 9934 1172', paid_on = $1, note = 'Paid the balance through UPI this morning.', status = 'pending'", [daysAgo(today, 1)]);

  // The staging generator bills its invoices without saying which engagement each line is for. The
  // app's editor links a line to the client's service of that type (fee realisation compares what
  // each engagement billed with its agreed fee), so link them the same way (bypassing the
  // issued-invoice guard, as above).
  await db.query("set local session_replication_role = replica");
  await q(
    db,
    `update public.invoice_items it set client_service_id = (
         select cs.id from public.client_services cs join public.invoices i on i.id = it.invoice_id
         where cs.client_id = i.client_id and cs.is_active and cs.service_type::text = it.service_type::text
         order by cs.created_at, cs.id limit 1
       )
      where it.client_service_id is null and it.service_type is not null`,
  );
  await db.query("set local session_replication_role = origin");
}

// =================================================================================================
// 8. Documents and document requests (rows only: the stack has no file storage)
// =================================================================================================

async function documents(ctx: Ctx) {
  const { db, today, fy, rand } = ctx;
  const polish: Array<[string, string, string, string]> = [
    [F.docShared("A"), "GSTR-3B acknowledgement, Sep 2026", "GSTR3B_Sep2026_ack.pdf", "acknowledgements"],
    [F.docPrivate("A"), "Purchase register, Sep 2026", "Purchase_register_Sep2026.xlsx", "gst"],
    [F.docShared("B"), "Audited financial statements, FY 2025-26", "Beta_AFS_FY2025-26.pdf", "audit"],
    [F.docPrivate("B"), "Board resolution for bank account change", "Board_resolution_Jul2026.pdf", "roc"],
    [F.docShared("C"), "LLP Form 11 acknowledgement", "Form11_SRN_ack.pdf", "acknowledgements"],
    [F.docPrivate("C"), "Partners' capital account working", "Capital_account_FY2025-26.xlsx", "income_tax"],
  ];
  for (const [id, title, file, category] of polish) {
    await q(db, "update public.documents set title = $2, file_name = $3, category = $4, financial_year = $5, sha256 = $6, file_size = $7, mime_type = $8, source = 'staff' where id = $1", [id, title, file, category, fy, hex64(id), 180_000 + Math.floor(Math.random() * 400_000), file.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
  }
  await q(db, "update public.document_tags set tag = 'gst-2b'");
  const kinds: Array<[string, string, string, string]> = [
    ["PAN card", "kyc", "PAN.pdf", "application/pdf"],
    ["GST registration certificate", "kyc", "GST_REG-06.pdf", "application/pdf"],
    ["Bank statement, Sep 2026", "bank_statements", "HDFC_statement_Sep2026.pdf", "application/pdf"],
    ["Sales register, Sep 2026", "gst", "Sales_register_Sep2026.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["Form 26AS, FY 2025-26", "income_tax", "26AS_FY2025-26.pdf", "application/pdf"],
    ["ITR-V acknowledgement, AY 2026-27", "acknowledgements", "ITR-V_AY2026-27.pdf", "application/pdf"],
    ["Engagement letter, FY 2026-27 (signed)", "engagement", "Engagement_letter_signed.pdf", "application/pdf"],
    ["Rent agreement, office premises", "agreements", "Rent_agreement_2025.pdf", "application/pdf"],
  ];
  const docs: Row[] = [];
  const active = ctx.clients.filter((c) => c.status === "active");
  for (const c of active) {
    const n = c.id === C.A || c.id === C.B ? kinds.length : rand.int(2, 4);
    for (let i = 0; i < n; i++) {
      const [title, category, file, mime] = kinds[(i + (c.code.charCodeAt(c.code.length - 1) % 3)) % kinds.length];
      const id = qid(`doc:${c.id}:${i}`);
      docs.push({
        id, client_id: c.id, title, category, financial_year: category === "kyc" || category === "agreements" ? null : fy, file_name: file, file_size: rand.int(60_000, 2_400_000), mime_type: mime,
        storage_path: `${c.id}/${id}.${file.split(".").pop()}`, sha256: hex64(id), version: 1, source: i === 2 && (c.id === C.A || c.id === C.B) ? "client_portal" : "staff", is_confidential: category === "kyc",
        shareable_with_client: category === "acknowledgements" || category === "engagement", uploaded_by: c.id === C.A ? (i === 2 ? uid("CA") : uid("E1")) : uid(rand.pick(["E1", "E4", "M1", "M2"] as UserKey[])),
        created_at: ist(daysAgo(today, rand.int(1, 120)), "12:00"), expiry_date: category === "agreements" ? addDays(today, 40) : null,
      });
    }
  }
  await ins(db, "documents", docs);
  bump(ctx, "documents", docs.length + 6);
  await ins(db, "document_versions", docs.filter((d) => d.category === "gst").slice(0, 6).map((d) => ({ document_id: d.id, version: 1, file_name: d.file_name, file_size: d.file_size, storage_path: d.storage_path, uploaded_by: d.uploaded_by, mime_type: d.mime_type, sha256: d.sha256 })), "");
  await ins(db, "document_tags", docs.slice(0, 20).map((d) => ({ document_id: d.id, tag: String(d.category) === "gst" ? "returns" : "kyc" })), "");
  await ins(db, "document_activities", docs.slice(0, 30).map((d) => ({ document_id: d.id, user_id: d.uploaded_by, activity: "uploaded", created_at: d.created_at })), "");
  // One document in the recycle bin.
  await q(db, "update public.documents set deleted_at = now() - interval '4 days', deleted_by = $2 where id = $1", [docs.find((d) => d.client_id !== C.A && d.category === "agreements")?.id ?? docs[docs.length - 1].id, uid("M1")]);

  // Document requests: an open one for Alpha Traders with items in every state.
  await q(db, "update public.document_requests set title = 'Documents for the GST return, Oct 2026', due_date = $1, notes = 'Please upload by the 5th so we can file on time.', reminder_every_days = 3, last_reminded_at = now() - interval '1 day', reminder_count = 1, contact_id = (select id from public.client_contacts cc where cc.client_id = document_requests.client_id and cc.is_primary limit 1)", [addDays(today, 8)]);
  await q(db, "update public.document_request_items set title = 'Bank statement, Oct 2026 (all accounts)', help_text = 'PDF from net banking is fine.', is_required = true");
  const reqA = fid("docreq:A");
  await ins(db, "document_request_items", [
    { request_id: reqA, title: "Sales register, Oct 2026", help_text: "Excel export from Tally.", status: "uploaded", document_id: docs.find((d) => d.client_id === C.A && d.category === "gst")?.id ?? null, uploaded_at: ist(daysAgo(today, 1), "19:20"), sort_order: 2 },
    { request_id: reqA, title: "Purchase invoices above ₹50,000", status: "rejected", rejection_reason: "Two pages are cut off; please scan again.", reviewed_at: earlierToday(today, "10:15"), reviewed_by: uid("E1"), sort_order: 3 },
    { request_id: reqA, title: "Credit notes received", status: "accepted", document_id: docs.find((d) => d.client_id === C.A && d.category === "bank_statements")?.id ?? null, reviewed_at: ist(daysAgo(today, 2)), reviewed_by: uid("E1"), sort_order: 4 },
  ], "");
  await ins(db, "document_requests", [
    { id: qid("docreq:B:audit"), client_id: C.B, title: "PBC list for the statutory audit, FY 2025-26", status: "open", due_date: addDays(today, 4), notes: "Prepared-by-client schedules for the audit.", created_by: uid("M1"), reminder_every_days: 2, reminder_count: 2, last_reminded_at: ist(daysAgo(today, 1)) },
    { id: qid("docreq:C:done"), client_id: C.C, title: "KYC refresh for designated partners", due_date: daysAgo(today, 10), created_by: uid("M1") },
  ], "");
  await ins(db, "document_request_items", [
    { request_id: qid("docreq:B:audit"), title: "Fixed asset register with additions", status: "pending", sort_order: 1 },
    { request_id: qid("docreq:B:audit"), title: "Stock statement as on 31 Mar 2026", status: "pending", sort_order: 2 },
    { request_id: qid("docreq:B:audit"), title: "Loan confirmations from SBI", status: "pending", sort_order: 3 },
    { request_id: qid("docreq:C:done"), title: "Aadhaar-masked ID of each partner", status: "accepted", document_id: qid(`doc:${C.C}:0`), sort_order: 1, reviewed_at: ist(daysAgo(today, 12)), reviewed_by: uid("M1") },
  ], "");
  await q(db, "update public.document_requests set status = 'completed', completed_at = $2 where id = $1", [qid("docreq:C:done"), ist(daysAgo(today, 12))]);
  await q(db, "update public.document_requests set title = 'Documents for the TDS return, Q2' where id = $1", [fid("docreq:B")]);
  await q(db, "update public.document_requests set title = 'LLP annual filing documents' where id = $1", [fid("docreq:C")]);
}

// =================================================================================================
// 9. Messages, threads, notifications, email deliveries
// =================================================================================================

async function communication(ctx: Ctx) {
  const { db, today } = ctx;
  const polish: Record<string, string> = {
    portal: "Hello! Your GSTR-1 for September is filed. The ARN is in Documents. For GSTR-3B we still need the purchase invoices above ₹50,000.",
    email: "Dear Sir/Madam, please find attached the computation for the advance tax instalment due on 15 December.",
    note: "Client prefers calls after 4 pm. The son (Rohan) handles the books.",
    invoice: "Your invoice for GST return filing (Aug 2026) is attached. Amount due: ₹5,900.00.",
  };
  for (const k of ["A", "B", "C"] as const) {
    for (const [kind, body] of Object.entries(polish)) await q(db, "update public.messages set body = $2, subject = $3, sent_at = now() - interval '6 days', created_at = now() - interval '6 days' where id = $1", [fid(`msg:${k}:${kind}`), body, kind === "email" ? "Advance tax: third instalment" : kind === "invoice" ? "Invoice from TaxWise Consultants" : null]);
  }
  const contactA = fid("contact:A");
  const thread = (client: string, contact: string | null, items: Array<[string, "inbound" | "outbound", UserKey | null, number, string]>) =>
    items.map(([body, direction, by, minutesAgo, status]) => ({ client_id: client, contact_id: contact, channel: "portal", direction, body, status, sent_by: by ? uid(by) : null, sent_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), read_at: direction === "outbound" && minutesAgo > 300 ? new Date(Date.now() - (minutesAgo - 30) * 60_000).toISOString() : null }));
  await ins(db, "messages", [
    ...thread(C.A, contactA, [
      ["I have uploaded the bank statements for October. Do you need anything else for GST?", "inbound", null, 60 * 26, "delivered"],
      ["Thank you, Mahesh. We also need the purchase invoices above ₹50,000; two pages of the last upload were cut off.", "outbound", "E1", 60 * 25, "read"],
      ["Sending them again tonight.", "inbound", null, 60 * 3, "delivered"],
      ["Also, can you tell me how much advance tax I should pay in December?", "inbound", null, 45, "delivered"],
    ]),
    ...thread(C.B, fid("contact:B"), [
      ["The PBC schedules are with Venkatesh; he will upload by Tuesday.", "inbound", null, 60 * 30, "delivered"],
      ["Thanks Sunita. Please ask him to include the loan confirmations from SBI.", "outbound", "M1", 60 * 29, "read"],
    ]),
    { client_id: C.B, channel: "email", direction: "outbound", recipient: "venkatesh@beta-industries.example.com", subject: "Statutory audit: PBC list", body: "Dear Venkatesh, attached is the PBC list for the FY 2025-26 audit.", status: "delivered", sent_by: uid("M1"), sent_at: ist(daysAgo(today, 3), "11:00"), created_at: ist(daysAgo(today, 3), "11:00"), delivered_at: ist(daysAgo(today, 3), "11:01") },
    { client_id: C.B, channel: "email", direction: "outbound", recipient: "harsha@beta-industries.example.com", subject: "GSTR-3B challan for Sep 2026", body: "Harsha, the challan for ₹1,84,350 is ready; please pay by 4 pm today.", status: "failed", error: "Mailbox full (552)", sent_by: uid("E1"), sent_at: earlierToday(today, "09:40"), created_at: earlierToday(today, "09:40"), failed_at: earlierToday(today, "09:41", 4) },
    { client_id: C.C, channel: "whatsapp_handoff", direction: "outbound", recipient: "+91 90000 73002", body: "Asha, please share the TDS challans for September.", status: "handed_off", sent_by: uid("E1"), sent_at: ist(daysAgo(today, 2), "12:30"), created_at: ist(daysAgo(today, 2), "12:30") },
    { client_id: C.C, channel: "call_log", direction: "outbound", body: "Called Nikhil about the internal audit quotation; he will decide after the partners' meeting on Monday.", status: "sent", sent_by: uid("P1"), sent_at: ist(daysAgo(today, 1), "17:00"), created_at: ist(daysAgo(today, 1), "17:00") },
    { client_id: C.A, channel: "internal_note", direction: "outbound", body: "Mahesh wants a meeting about restructuring into an LLP next year. Flag to Raghavendra.", status: "sent", sent_by: uid("E1"), sent_at: ist(daysAgo(today, 4), "13:00"), created_at: ist(daysAgo(today, 4), "13:00") },
  ], "");
  await ins(db, "message_thread_reads", [
    { client_id: C.B, user_id: uid("M1"), last_read_at: new Date().toISOString() },
    { client_id: C.A, user_id: uid("E1"), last_read_at: new Date(Date.now() - 60 * 26 * 60_000).toISOString() },
  ], "");
  await ins(db, "email_deliveries", [
    { idempotency_key: "qa:invoice:A", kind: "invoice", recipient: "accounts@alpha-traders.example.com", subject: "Invoice from TaxWise Consultants", status: "delivered", attempts: 1, client_id: C.A, sent_by: uid("P1"), sent_at: ist(daysAgo(today, 50)), delivered_at: ist(daysAgo(today, 50)) },
    { idempotency_key: "qa:reminder:B", kind: "invoice_reminder", recipient: "finance@beta-industries.example.com", subject: "Payment reminder", status: "opened", attempts: 1, client_id: C.B, sent_at: ist(daysAgo(today, 7)), delivered_at: ist(daysAgo(today, 7)), opened_at: ist(daysAgo(today, 6)) },
    { idempotency_key: "qa:portal-invite:C", kind: "portal_invite", recipient: "nikhil@gamma-llp.example.com", subject: "Your TaxWise client portal", status: "bounced", attempts: 1, client_id: C.C, sent_at: ist(daysAgo(today, 2)), bounced_at: ist(daysAgo(today, 2)), error: "Address does not exist" },
  ], "");

  // Notifications: replace the fixture greeting with each person's real inbox.
  await q(db, "delete from public.notifications where body = 'Fixture notification'");
  const n = (k: UserKey, type: string, title: string, body: string, link: string, minutesAgo: number, read = false, entity?: [string, string]) => ({
    user_id: uid(k), type, title, body, link_url: link, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), read_at: read ? new Date(Date.now() - (minutesAgo - 5) * 60_000).toISOString() : null,
    entity_type: entity?.[0] ?? null, entity_id: entity?.[1] ?? null,
  });
  const t = (k: string) => qid(`task:${k}`);
  await ins(db, "notifications", [
    n("E1", "task_assigned", "New task: Reconcile GSTR-2B for Sep 2026", "Anita Rao assigned you a task for Beta Industries, due in 3 days. Accept or decline it.", `/work/${t("e1-waiting-2")}`, 50, false, ["task", t("e1-waiting-2")]),
    n("E1", "task_assigned", "New task: Advance tax working for Q3", "Anita Rao assigned you a task for Alpha Traders.", `/work/${t("e1-waiting")}`, 180, false, ["task", t("e1-waiting")]),
    n("E1", "task_sent_back", "Sent back: GSTR-3B for Sep 2026", "ITC on two invoices from Kaveri Traders isn't in GSTR-2B yet. Hold that credit back, recompute and resubmit.", `/work/${t("e1-sent-back")}`, 60 * 22, false, ["task", t("e1-sent-back")]),
    n("E1", "task_overdue", "Overdue: TDS return 26Q for Q2", "It was due 3 days ago.", `/work/${t("e1-overdue")}`, 60 * 9, true, ["task", t("e1-overdue")]),
    n("E1", "document_uploaded", "Mahesh Gowda uploaded the sales register", "Alpha Traders · Documents for the GST return, Oct 2026", `/clients/${C.A}?tab=documents&docs=requests&request=${fid("docreq:A")}`, 60 * 20, true),
    n("E1", "info", "New portal message from Alpha Traders", "Also, can you tell me how much advance tax I should pay in December?", `/clients/${C.A}?tab=communication`, 44),
    n("M1", "review_requested", "Review: PF and ESIC returns for Sep 2026", "Ravi Kumar sent this for your review.", `/work/${t("e1-review")}`, 60 * 16, false, ["task", t("e1-review")]),
    n("M1", "review_requested", "Review: GSTR-1 (IFF) for Sep 2026", "Kiran Shetty sent this for your review.", `/work/${t("m1-review")}`, 80, false, ["task", t("m1-review")]),
    n("M1", "task_declined", "Declined: Statutory audit fieldwork: inventory observation", "Deepa Nair: no capacity (two tax audits due on 31 Oct).", `/work/${t("declined")}`, 60 * 23, false, ["task", t("declined")]),
    n("M1", "leave_requested", "Leave request from Meghana Iyer", `Half a day on ${formatDate(addDays(today, 4))} for ICAI exam registration.`, "/leave", 60 * 5),
    n("M1", "cover_started", "Cover in force: Meghana Iyer for Beta Industries", "While Deepa Nair is on sick leave.", `/clients/${C.B}`, 60 * 25, true),
    n("M1", "invoice_awaiting_approval", "Invoice to approve", "Beta Industries · ₹2,65,500.00 (audit fees).", "/invoices?status=awaiting_approval", 60 * 3, true),
    n("P1", "invoice_awaiting_approval", "2 invoices are waiting for your approval", "Beta Industries ₹2,65,500.00 and one more.", "/invoices?status=awaiting_approval", 70),
    n("P1", "quotation_viewed", "Gamma Architects LLP opened your quotation", "Third view this morning.", `/quotations/${qid("quotation:viewed")}`, 60 * 3),
    n("P1", "quotation_responded", "Desai Interiors accepted the quotation", "Start onboarding from the quotation.", `/quotations/${qid("quotation:accepted")}`, 60 * 24 * 5, true),
    n("P1", "payment_received", "Payment received from Beta Industries", "₹28,495.00 by bank transfer, with TDS ₹2,450.00.", `/invoices/${qid("invoice:paid-tds")}`, 60 * 24 * 25, true),
    n("P1", "expiry_alert", "DSC expiring in 12 days", "Sunita Reddy (Beta Industries).", "/registers?tab=dsc", 60 * 8),
    n("P1", "warning", "Peer review certificate expires in 5 months", "Plan the next peer review.", "/quality?tab=peer-reviews", 60 * 24 * 2, true),
    n("P2", "invoice_awaiting_approval", "2 invoices are waiting for your approval", "Beta Industries ₹2,65,500.00 and one more.", "/invoices?status=awaiting_approval", 70),
    n("M2", "leave_requested", "Leave request from Kiran Shetty", "5 days of annual leave for Deepavali week.", "/leave", 60 * 6),
    n("E4", "review_requested", "Under review: GSTR-1 (IFF) for Sep 2026", "Anita Rao is reviewing it.", `/work/${t("m1-review")}`, 70, true),
    n("E3", "cover_started", "You're covering Beta Industries", "Until Deepa Nair is back on " + addDays(today, 3) + ".", `/clients/${C.B}`, 60 * 25),
  ], "");
  bump(ctx, "notifications", 22);
}

// =================================================================================================
// 10. WhatsApp groups and the linked PCs
// =================================================================================================

async function whatsapp(ctx: Ctx) {
  const { db, today } = ctx;
  const numbers = await q<{ id: string; label: string; in_every: boolean }>(db, "select id, label, in_every_client_group as in_every from public.firm_whatsapp_numbers where is_active order by label");
  const every = numbers.filter((x) => x.in_every);
  const done = (by: string, at: string, contactIds: string[]): ChecklistState => ({ steps: Object.fromEntries(CHECKLIST_STEP_IDS.map((id) => [id, { done: true, by, at }])) as ChecklistState["steps"], contactIds });
  for (const k of ["A", "B", "C"] as const) {
    const client = ctx.byId.get(C[k])!;
    await q(db, "update public.client_whatsapp_groups set name = $2, purpose = 'Day-to-day compliance', created_on = '2026-04-12', created_by_number_id = $3, checklist = $4, last_opened_at = now() - interval '2 days', last_opened_by = $5 where id = $1", [F.waGroup(k), `TW · ${client.name} · ${client.code}`, every[0]?.id ?? null, json(checklistToJson(done(uid("M1"), ist("2026-04-12"), [fid(`contact:${k}`)]))), uid("E1")]);
    await q(db, "update public.client_whatsapp_group_members set display_name = (select name from public.client_contacts where id = $2), number = $3, contact_id = $2, added_on = '2026-04-12', source = 'checklist' where group_id = $1", [F.waGroup(k), fid(`contact:${k}`), `91900007${k === "A" ? "1001" : k === "B" ? "2001" : "3001"}`]);
    await ins(db, "client_whatsapp_group_members", every.map((nb) => ({ group_id: F.waGroup(k), kind: "firm_number", firm_number_id: nb.id, display_name: nb.label, is_admin: true, added_on: "2026-04-12", source: "checklist" })), "");
  }
  const others = ctx.clients.filter((c) => c.status === "active" && ![C.A, C.B, C.C].includes(c.id)).slice(0, 14);
  const groups: Row[] = [];
  const members: Row[] = [];
  others.forEach((c, i) => {
    const id = qid(`wa:${c.id}`);
    const state = i === 0 ? "to_create" : i === 1 ? "closed" : "active";
    groups.push({
      id, client_id: c.id, name: `TW · ${c.name} · ${c.code}`, purpose: i === 1 ? "FY 2025-26 audit" : "Day-to-day compliance", is_primary: i !== 1, status: state, created_on: state === "to_create" ? null : addDays(today, -200 + i * 5),
      created_by_number_id: state === "to_create" ? null : every[0]?.id ?? null, invite_link: state === "active" ? `https://chat.whatsapp.com/QA${hex64(id).slice(0, 18)}` : null,
      checklist: json(state === "to_create" ? checklistToJson({ steps: Object.fromEntries(CHECKLIST_STEP_IDS.map((s, j) => [s, { done: j < 2, by: j < 2 ? uid("M1") : null, at: j < 2 ? ist(daysAgo(today, 1)) : null }])) as ChecklistState["steps"], contactIds: null }) : checklistToJson(done(uid("M1"), ist(addDays(today, -200 + i * 5)), []))),
      last_opened_at: state === "active" ? ist(daysAgo(today, i % 9), "12:00") : null, last_opened_by: state === "active" ? uid(i % 2 ? "E1" : "M2") : null,
      closed_at: state === "closed" ? ist(daysAgo(today, 30)) : null, closed_reason: state === "closed" ? "Audit finished; day-to-day group continues." : null,
    });
    if (state !== "to_create") for (const nb of every) members.push({ group_id: id, kind: "firm_number", firm_number_id: nb.id, display_name: nb.label, is_admin: true, added_on: addDays(today, -200 + i * 5), source: "checklist" });
  });
  await ins(db, "client_whatsapp_groups", groups, "");
  await ins(db, "client_whatsapp_group_members", members, "");
  bump(ctx, "whatsapp_groups", groups.length + 3);
  await q(db, "update public.desktop_devices set device_name = 'Front desk PC', os = 'Windows 11', app_version = '1.4.0', last_seen_at = now() - interval '6 minutes', last_user_id = $1", [uid("M1")]);
  await ins(db, "desktop_devices", [
    { device_key: "qa-device-partner-laptop", device_name: "Raghavendra's laptop", os: "macOS 15", app_version: "1.4.0", last_user_id: uid("P1"), last_seen_at: new Date(Date.now() - 3600_000).toISOString() },
    { device_key: "qa-device-old-pc", device_name: "Old reception PC", os: "Windows 10", app_version: "1.2.1", last_user_id: uid("M2"), last_seen_at: ist(daysAgo(today, 40)), revoked_at: ist(daysAgo(today, 35)), revoked_by: uid("P1") },
  ], "");
}

// =================================================================================================
// 11. Registers: registrations, DSC, UDIN, credentials (sealed with the vault), KYC
// =================================================================================================

async function registers(ctx: Ctx) {
  const { db, today, rand } = ctx;
  const keyring = keyringFromEnv();
  const regs: Row[] = [];
  const dsc: Row[] = [];
  const creds: Row[] = [];
  const active = ctx.clients.filter((c) => c.status === "active");
  active.forEach((c, i) => {
    if (c.gstin) regs.push({ client_id: c.id, registration_type: "GST", registration_number: c.gstin, jurisdiction: "State: Karnataka, Ward 45", issue_date: "2019-07-01", status: "active" });
    if (i % 3 === 0) regs.push({ client_id: c.id, registration_type: "MSME_UDYAM", registration_number: `UDYAM-KR-03-00${String(41000 + i * 37).padStart(5, "0")}`, issue_date: "2021-03-12", status: "active" });
    if (i % 4 === 1) regs.push({ client_id: c.id, registration_type: "SHOPS_ESTAB", registration_number: `BBMP/SE/${2020 + (i % 5)}/${4100 + i}`, issue_date: "2021-01-01", expiry_date: addDays(today, i % 8 === 1 ? 21 : 400), reminder_days: 30, status: "active" });
    if (c.entity === "pvt_ltd" || c.entity === "public_ltd") {
      regs.push({ client_id: c.id, registration_type: "PF", registration_number: `KNBNG${String(1_200_000 + i * 113).slice(0, 7)}000`, status: "active" });
      dsc.push({ client_id: c.id, holder_name: `Director of ${c.name}`, holder_pan: c.pan, dsc_class: "Class 3", serial_number: `${hex64(c.id).slice(0, 16).toUpperCase()}`, issued_by: "eMudhra", issue_date: addDays(today, -700 + i * 10), expiry_date: addDays(today, i % 5 === 0 ? 12 : i % 5 === 1 ? -20 : 300 + i * 7), custody: i % 2 ? "With the firm" : "With the client", status: i % 5 === 1 ? "expired" : "active" });
    }
    if (i < 18) {
      for (const portal of i % 2 ? ["GST", "INCOME_TAX"] : ["GST", "INCOME_TAX", "TRACES"]) {
        const id = qid(`cred:${c.id}:${portal}`);
        creds.push({ id, client_id: c.id, portal, username: portal === "GST" ? `${(c.name.split(" ")[0] || "client").toLowerCase()}${100 + i}` : c.pan ?? `user${i}`, password_ciphertext: encryptSecret(`Qa#${hex64(id).slice(0, 10)}`, { keyring, context: credentialContext(c.id) }), login_url: portal === "GST" ? "https://services.gst.gov.in" : portal === "TRACES" ? "https://www.tdscpc.gov.in" : "https://eportal.incometax.gov.in", updated_by: uid("M1") });
      }
    }
  });
  await ins(db, "statutory_registrations", regs, "");
  await ins(db, "dsc_records", dsc, "");
  await q(db, "delete from public.client_credentials where client_id = any($1)", [creds.map((c) => c.client_id)]);
  await ins(db, "client_credentials", creds, "");
  // The fixture credentials (A/B/C) are sealed properly too.
  for (const k of ["A", "B", "C"] as const) {
    await q(db, "update public.client_credentials set password_ciphertext = $2, username = $3, login_url = 'https://services.gst.gov.in', updated_by = $4 where id = $1", [F.credential(k), encryptSecret(`Qa#${k}${hex64(k).slice(0, 8)}`, { keyring, context: credentialContext(C[k]) }), `${k.toLowerCase()}_gst_login`, uid("M1")]);
  }
  await ins(db, "credential_access_logs", creds.slice(0, 10).map((c, i) => ({ credential_id: c.id, user_id: uid(i % 3 ? "E1" : "M1"), action: i % 4 ? "viewed" : "copied", ip: "10.0.0.21", created_at: ist(daysAgo(today, i), "12:30") })), "");
  bump(ctx, "registrations", regs.length);
  bump(ctx, "dsc", dsc.length);
  bump(ctx, "credentials", creds.length);
  await q(db, "update public.dsc_records set holder_name = 'Sunita Reddy', holder_pan = 'BXRPR4521K', dsc_class = 'Class 3', issued_by = 'eMudhra', expiry_date = $2, custody = 'With the firm' where client_id = $1", [C.B, addDays(today, 12)]);
  await q(db, "update public.statutory_registrations set registration_number = 'PTEC-' || substr(md5(client_id::text), 1, 8), jurisdiction = 'Bengaluru Urban' where registration_type = 'PT'");

  // UDIN: tax audit reports and certificates signed this season.
  const audited = active.filter((c) => c.entity !== "individual" && c.entity !== "huf").slice(0, 10);
  const udins: Row[] = audited.map((c, i) => ({
    client_id: c.id, udin: `26${["212345", "223456"][i % 2]}${hex64(c.id).replace(/[^A-F0-9]/gi, "").toUpperCase().slice(0, 10)}`.slice(0, 18), document_type: i < 7 ? "Tax audit report" : "Turnover certificate",
    document_date: addDays(today, -30 + i), signed_on: addDays(today, -30 + i), generated_on: addDays(today, -30 + i), signing_partner_id: uid(i % 2 ? "P2" : "P1"),
    report_form: i < 7 ? (c.entity === "pvt_ltd" ? "3CA" : "3CB_44AB_a") : "certificate", financial_year: previousFinancialYear(ctx.fy), counts_towards_tax_audit_ceiling: i < 7, created_by: uid("M1"),
  }));
  await ins(db, "udin_records", udins, "");
  bump(ctx, "udin_records", udins.length + 3);
  void rand;
}

// =================================================================================================
// 12. Practice: engagement letters, audits, quality
// =================================================================================================

async function practice(ctx: Ctx) {
  const { db, today, fy } = ctx;
  const sched = (rows: Array<[string, string, string, number]>) => json(rows.map(([service_type, description, frequency, fee]) => ({ service_type, description, frequency, fee: fee.toFixed(2) })));
  await q(db, "update public.engagement_letters set status = 'signed', scope = 'Monthly GST returns (GSTR-1 and GSTR-3B), annual return, and replies to routine notices.', services_schedule = $2, issued_at = $3, signed_at = $4, expires_at = '2027-03-31', sent_to = 'accounts@alpha-traders.example.com', signatory_id = $5 where client_id = $1", [C.A, sched([["gst", "GST return filing (12 months)", "monthly", 60000]]), ist("2026-04-05"), ist("2026-04-09"), uid("P1")]);
  await q(db, "update public.engagement_letters set status = 'issued', service_types = '{audit}', scope = 'Statutory audit under the Companies Act, 2013 and tax audit under s.44AB for FY 2025-26.', audit_type = 'statutory_companies_act', reporting_framework = 'Ind AS not applicable; AS (Companies (Accounting Standards) Rules, 2021)', services_schedule = $2, fee_agreed = 225000, issued_at = $3, sent_at = $3, sent_to = 'sunita@beta-industries.example.com', signatory_id = $4 where client_id = $1", [C.B, sched([["audit", "Statutory audit, FY 2025-26", "annual", 150000], ["audit", "Tax audit, FY 2025-26", "annual", 75000]]), ist(daysAgo(today, 9)), uid("P2")]);
  await q(db, "update public.engagement_letters set status = 'draft', service_types = '{company_law,income_tax}', scope = 'LLP annual filings and income-tax return for FY 2025-26.', services_schedule = $2, fee_agreed = 58000 where client_id = $1", [C.C, sched([["company_law", "LLP Form 8 and Form 11", "annual", 18000], ["income_tax", "Income-tax return", "annual", 40000]])]);
  const more = ctx.clients.filter((c) => c.status === "active" && ![C.A, C.B, C.C].includes(c.id)).slice(0, 6);
  await ins(db, "engagement_letters", more.map((c, i) => ({
    client_id: c.id, financial_year: fy, service_types: i % 2 ? ["gst", "income_tax"] : ["income_tax"], scope: "Compliance services as listed in the schedule.", fee_agreed: 30000 + i * 5000,
    services_schedule: sched([["income_tax", "Income-tax return", "annual", 30000 + i * 5000]]), status: ["signed", "signed", "issued", "declined", "expired", "draft"][i],
    issued_at: i < 5 ? ist(addDays(today, -120 + i * 10)) : null, signed_at: i < 2 ? ist(addDays(today, -110 + i * 10)) : null, declined_reason: i === 3 ? "Client wants to continue on last year's letter." : null,
    expires_at: i === 4 ? daysAgo(today, 5) : "2027-03-31", created_by: uid("M1"), signatory_id: uid("P1"),
  })), "");

  // The statutory audit of Beta Industries, mid-way (Execution), and the fixture tax audits.
  const id = qid("audit:beta-statutory");
  const at = (d: number) => ist(daysAgo(today, d), "16:00");
  const steps: Record<string, Row> = {};
  let executionSteps = 0;
  for (const s of AUDIT_STEPS) {
    if (!stepApplies(s, "statutory_companies_act")) continue;
    if (s.stage === "acceptance" || s.stage === "planning" || s.stage === "risk_assessment") {
      steps[s.key] = { prepared_by: uid("E2"), prepared_at: at(40), reviewed_by: uid("P2"), reviewed_at: at(38), na: false, na_reason: null, note: null };
    } else if (s.stage === "execution" && executionSteps++ % 2 === 0) {
      steps[s.key] = { prepared_by: uid("E1"), prepared_at: at(3), reviewed_by: null, reviewed_at: null, na: false, na_reason: null, note: "Vouching done for the top 40 purchase invoices." };
    }
  }
  const mat = computeMateriality({ basis: "revenue", baseAmountPaise: toPaise(186_000_000), percent: 1, performancePercent: 75, trivialPercent: 5 });
  await ins(db, "audit_engagements", [{
    id, client_id: C.B, audit_type: "statutory_companies_act", financial_year: previousFinancialYear(fy), engagement_partner_id: emp("P2"), review_manager_id: emp("M1"), stage: "execution",
    materiality: { basis: "revenue", base_amount: 186000000, percent: 1, overall: mat.overallPaise / 100, performance_percent: 75, performance: mat.performancePaise / 100, trivial_percent: 5, trivial: mat.trivialPaise / 100, rationale: "Revenue is the most stable benchmark for a manufacturing company with thin margins.", determined_on: daysAgo(today, 39), determined_by: uid("P2") },
    checklist: { steps }, caro_applicable: true, had_previous_auditor: false, accepted_on: "2026-04-05",
    company_profile: { is_public: false, is_one_person_company: false, is_section8: false, is_banking: false, is_insurance: false, is_holding_or_subsidiary: false, is_holding_or_subsidiary_of_public: false, is_special_act: false, is_dormant: false, paid_up_capital: 5000000, turnover: 186000000, capital_and_reserves: 64000000, max_borrowings: 30000000, revenue: 188500000 },
    counts_towards_company_audit_limit: true, created_by: uid("P2"), notes: "Inventory observation pending (task declined by Deepa; reassign).",
  }], "");
  await ins(db, "audit_engagement_stage_log", [
    { engagement_id: id, from_stage: "acceptance", to_stage: "planning", approved_by: uid("P2"), note: "Independence and acceptance cleared.", at: at(45) },
    { engagement_id: id, from_stage: "planning", to_stage: "risk_assessment", approved_by: uid("P2"), note: "Materiality set at 1% of revenue.", at: at(39) },
    { engagement_id: id, from_stage: "risk_assessment", to_stage: "execution", approved_by: uid("P2"), note: null, at: at(30) },
  ], "");
  await ins(db, "audit_engagement_documents", [{ engagement_id: id, document_id: F.docShared("B"), step_key: AUDIT_STEPS.find((s) => s.stage === "planning")?.key ?? "planning", added_by: uid("E2") }], "");
  // The fixture records the partner's profile id; the app reads employees.id (audit_engagements_list).
  await q(db, "update public.audit_engagements set engagement_partner_id = $1 where audit_type = 'tax_audit'", [emp("P1")]);
  await q(db, "update public.audit_engagements set engagement_partner_id = $2, review_manager_id = $3, stage = 'planning', notes = 'Tax audit under s.44AB.' where client_id = $1 and audit_type = 'tax_audit'", [C.B, emp("P2"), emp("M1")]);
  await q(db, "update public.previous_auditor_communications set previous_auditor_name = 'K S Rao & Associates', previous_auditor_frn = '009876S', sent_via = 'email', reply_received_on = letter_sent_on + 6, outcome = 'no_objection', notes = 'No professional reasons not to accept.'");

  // Quality: owners and review dates on the manual, the peer review, restore drills.
  await q(db, "update public.quality_manual_items set owner_employee_id = $1, last_reviewed_on = $2, last_reviewed_by = $3 where sort_order % 2 = 0", [emp("P1"), daysAgo(today, 60), uid("P1")]);
  await q(db, "update public.quality_manual_items set owner_employee_id = $1, last_reviewed_on = $2, last_reviewed_by = $3 where sort_order % 2 = 1 and sort_order < 15", [emp("P2"), daysAgo(today, 400), uid("P2")]);
  await q(db, "update public.peer_reviews set reviewer_name = 'CA Meera Joshi', reviewer_frn = '011223W', status = 'completed', reviewed_on = '2024-11-20', certificate_no = 'PRB/2024/7781', valid_until = $1, observations = 'Strengthen documentation of materiality in smaller audits.'", [addDays(today, 150)]);
  await q(db, "update public.restore_drills set performed_by = $1, backup_reference = 'pitr-2026-10-01T02:00Z', restored_to = 'staging', duration_minutes = 42, checks = 'Row counts, last invoice number, a random credential reveal.', notes = 'Clean restore.'", [uid("P1")]);
  await ins(db, "restore_drills", [{ performed_on: "2026-07-03", performed_by: uid("P1"), outcome: "passed_with_issues", issues: "Logo bucket was not part of the backup; re-uploaded by hand.", backup_reference: "pitr-2026-07-01T02:00Z", restored_to: "staging", duration_minutes: 65 }], "");
  await q(db, "update public.tax_audit_external_counts set notes = 'Signed at the previous firm before joining.'");
}

// =================================================================================================
// 13. Workpapers: GST reconciliation, ITR, financial statements, notices (the app's own engines)
// =================================================================================================

async function workpapers(ctx: Ctx) {
  const { db, today, fy } = ctx;
  // Replace the fixture placeholders ('{}') with real results.
  await q(db, "delete from public.gst_recon_entries");
  await q(db, "delete from public.gst_recon_runs");
  await q(db, "delete from public.itr_computations");
  await q(db, "delete from public.financial_statements");

  // GST reconciliation for Beta Industries, Sep 2026, from the GSTR-2B and register fixtures.
  const fx = join(ROOT, "tests", "fixtures", "gstr2b");
  // Imports of goods (IMPG, no supplier GSTIN) are left out: save_gst_recon_run stores '' for a missing
  // GSTIN and the normalize_upper trigger turns that into NULL, which gst_recon_entries refuses (an app
  // bug reported by the QA run, not worked around here beyond keeping the dataset loadable).
  const twoB = JSON.parse(readFileSync(join(fx, "gstr2b-sep-2026.json"), "utf8")) as { data: { docdata: Record<string, unknown> } };
  delete twoB.data.docdata.impg;
  delete twoB.data.docdata.impgsez;
  const portal = parseGstr2b(JSON.stringify(twoB));
  const reg = JSON.parse(readFileSync(join(fx, "purchase-register-sep-2026.json"), "utf8")) as { headers: string[]; rows: SheetRow[] };
  const mapping = mapColumns(reg.headers).mapping;
  const books = parseRegisterRows(reg.rows.filter((r) => String(r["GSTIN of Supplier"] ?? "").trim() !== ""), mapping);
  if (!portal.ok) throw new Error("The GSTR-2B fixture didn't parse.");
  const result = reconcile(portal.rows, books.rows, { clientGstin: "29AAKCB1111F1Z3", portalGstin: portal.gstin });
  const runId = qid("recon:beta:092026");
  const regDoc = qid(`doc:${C.B}:3`);
  const summary = {
    version: 1,
    summary: {
      buckets: Object.fromEntries(Object.entries(result.summary.buckets).map(([k, b]) => [k, { count: b.count, portalItc: b.portalItc, booksItc: b.booksItc }])),
      byTier: result.summary.byTier,
      documents: result.summary.documents,
      itc: result.summary.itc,
    },
    suppliers: result.suppliers.map((s) => ({ supplierGstin: s.supplierGstin, supplierName: s.supplierName, counts: s.counts, itcAtRisk: s.itcAtRisk, unclaimedItc: s.unclaimedItc, mismatchDifference: s.mismatchDifference, chase: s.chase })),
    warnings: result.warnings,
    gstr2b: { gstin: portal.gstin, period: portal.period, generatedOn: portal.generatedOn, counts: portal.counts, documents: portal.rows.length },
    register: { ...books.counts, fileName: "Purchase_register_Sep2026.xlsx", sheet: "Sheet1" },
    carryForward: null,
  };
  await ins(db, "gst_recon_runs", [{
    id: runId, client_id: C.B, period: "092026", portal_gstin: portal.gstin, summary, register_document_id: regDoc,
    diagnostics: { gstr2b: portal.diagnostics.slice(0, 300), register: books.issues.slice(0, 500), truncated: { gstr2b: 0, register: 0 } },
    source_files: { gstr2b: { bucket: "task-files", path: `gst-recon/${C.B}/gstr2b-092026.json`, fileName: "GSTR2B_092026.json", size: 18_204, sha256: hex64("2b"), gstin: portal.gstin, period: portal.period }, register: { documentId: regDoc, fileName: "Purchase_register_Sep2026.xlsx", sheet: "Sheet1", headerRow: 1 }, mapping },
    created_by: uid("E1"), created_at: ist(daysAgo(today, 2), "15:20"),
  }], "");
  const imsByKey = new Map(result.ims.map((i) => [i.entryKey, i]));
  await ins(db, "gst_recon_entries", result.entries.map((e, i) => ({
    run_id: runId, entry_key: e.key, bucket: e.bucket, match_tier: e.tier, supplier_gstin: e.supplierGstin, supplier_name: e.supplierName, data: entryData(e),
    resolution: e.bucket === "matched" ? "open" : i % 3 === 0 ? "follow_up_supplier" : "open", resolution_note: e.bucket !== "matched" && i % 3 === 0 ? "Wrote to the supplier to upload the invoice in their GSTR-1." : null,
    ims_action: imsByKey.get(e.key)?.action ?? null, ims_reason: imsByKey.get(e.key)?.reason ?? null, origin: "current", first_seen_period: "092026",
  })), "");
  bump(ctx, "gst_recon_entries", result.entries.length);

  // ITR computations for individuals and HUFs, through the app's form → engine path.
  const paramRows = await q<{ id: string; key: string; value: unknown; effective_from: string; effective_to: string | null; verified: boolean; source_ref: string | null; updated_at: string }>(
    db,
    "select id, key, value, effective_from::text, effective_to::text, verified, source_ref, updated_at::text from public.statutory_parameters where key = $1",
    [ITR_RULESET_PARAM_KEY],
  );
  const rows = paramRows.map((r) => ({ id: r.id, key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified, sourceRef: r.source_ref, updatedAt: r.updated_at }));
  const itrFy = previousFinancialYear(fy);
  const resolved = resolveItrRuleSet(rows, itrFy);
  const raw = parameterInForce(rows, ITR_RULESET_PARAM_KEY, fyStart(itrFy));
  if (!resolved.ok || !raw) throw new Error(`No ITR rule set for ${itrFy}.`);
  const people = await q<{ id: string; entity_type: string; display_name: string }>(db, "select id, entity_type::text, display_name from public.clients where deleted_at is null and status = 'active' and entity_type in ('individual','huf') order by client_code limit 3");
  const itrClients = [{ id: C.A, entity_type: "proprietorship", display_name: "Alpha Traders" }, ...people];
  const plans = [
    { status: "draft", income: { businessProfession: "1840000", otherSources: "64000" }, deductions: { sec80CBasket: "150000", sec80D: { selfFamily: "25000", parents: "", parentsSenior: false } }, taxes: { tdsTcs: "12000", q1: "", q2: "20000" }, filing: addDays(today, 6), due: "2026-07-31", kind: "business" as const },
    { status: "reviewed", income: { salaryGross: "2450000", houseProperty: "-180000", otherSources: "42000", ltcg112a: "210000" }, deductions: { sec80CBasket: "150000", sec80CCD1B: "50000" }, taxes: { tdsTcs: "386000", q1: "", q2: "" }, filing: "2026-07-24", due: "2026-07-31", kind: "non_business" as const },
    { status: "final", income: { salaryGross: "1180000", otherSources: "28000" }, deductions: {}, taxes: { tdsTcs: "54000", q1: "", q2: "" }, filing: "2026-07-18", due: "2026-07-31", kind: "non_business" as const },
    { status: "draft", income: { otherSources: "640000", dividends: "120000", stcg111a: "85000" }, deductions: { sec80CBasket: "150000" }, taxes: { tdsTcs: "18000", q1: "", q2: "" }, filing: addDays(today, 10), due: "2026-07-31", kind: "non_business" as const },
  ];
  let made = 0;
  for (let i = 0; i < Math.min(itrClients.length, plans.length); i++) {
    const c = itrClients[i];
    const p = plans[i];
    const form = blankItrForm({ clientId: c.id, financialYear: itrFy, ageBand: "below_60", ageBandSource: "manual", filingDate: p.filing, dueDate: p.due, returnKind: p.kind, dueDateSource: "manual" });
    const input = { ...form, label: `${c.display_name}: AY 2026-27`, income: { ...form.income, ...p.income }, deductions: { ...form.deductions, ...p.deductions }, taxesPaid: { ...form.taxesPaid, tdsTcs: p.taxes.tdsTcs, advanceTax: { ...form.taxesPaid!.advanceTax!, q2: p.taxes.q2 } } };
    const values = ItrFormSchema.parse(input);
    const assessee = c.entity_type === "huf" ? "huf" : "individual";
    const converted = formToStoredInputs(values, assessee);
    if (!converted.ok) throw new Error(`ITR form for ${c.display_name} didn't convert: ${JSON.stringify(converted.fieldErrors)}`);
    const computed = computeStored(converted.stored, resolved.ruleSet);
    if (!computed.ok) throw new Error(`ITR for ${c.display_name} didn't compute: ${JSON.stringify(computed.fieldErrors)}`);
    await ins(db, "itr_computations", [{
      id: qid(`itr:${c.id}`), client_id: c.id, financial_year: itrFy, label: values.label, inputs: converted.stored, results: computed.result, rule_set: raw.value, rule_set_param_id: raw.id, rule_set_verified: resolved.verified,
      status: p.status, computed_at: ist(daysAgo(today, 3 + i)), prepared_by: uid("E1"), created_by: uid("E1"), created_at: ist(daysAgo(today, 5 + i)),
      reviewed_by: p.status !== "draft" ? uid("M2") : null, reviewed_at: p.status !== "draft" ? ist(daysAgo(today, 2 + i)) : null,
      regime_chosen: p.status === "final" ? computed.result.recommendedRegime : null, regime_chosen_by: p.status === "final" ? uid("M2") : null, regime_chosen_at: p.status === "final" ? ist(daysAgo(today, 2)) : null,
      finalised_by: p.status === "final" ? uid("M2") : null, finalised_at: p.status === "final" ? ist(daysAgo(today, 1)) : null,
    }], "");
    made++;
  }
  bump(ctx, "itr_computations", made);

  // Financial statements (Schedule III) from trial balances.
  const tb = (rows: Array<[string, "Dr" | "Cr", number]>): TbLedger[] => rows.map(([name, side, rupees], i) => ({ name, group: null, debit: side === "Dr" ? toPaise(rupees) : 0, credit: side === "Cr" ? toPaise(rupees) : 0, row: i + 2 }));
  const fsPlans: Array<{ client: string; entity: string; status: string; ledgers: TbLedger[] }> = [
    {
      client: C.B, entity: "pvt_ltd", status: "reviewed",
      ledgers: tb([
        ["Share capital", "Cr", 5_000_000], ["Profit & Loss A/c", "Cr", 52_400_000], ["Term loan from SBI", "Cr", 30_000_000], ["Sundry creditors", "Cr", 21_600_000], ["GST payable", "Cr", 1_840_000],
        ["Provision for income tax", "Cr", 4_200_000], ["Sales", "Cr", 186_000_000], ["Interest received", "Cr", 640_000], ["Plant and machinery", "Dr", 48_500_000], ["Computer software", "Dr", 1_200_000],
        ["Opening stock", "Dr", 14_800_000], ["Sundry debtors", "Dr", 38_600_000], ["HDFC Bank", "Dr", 9_420_000], ["Cash in hand", "Dr", 180_000], ["Purchases", "Dr", 112_000_000],
        ["Freight inward", "Dr", 2_900_000], ["Salaries", "Dr", 33_600_000], ["Interest on term loan", "Dr", 2_980_000], ["Depreciation", "Dr", 6_200_000], ["Rent", "Dr", 2_400_000],
        ["Security deposit", "Dr", 1_500_000], ["Loans and advances to staff", "Dr", 900_000], ["Mutual fund investment", "Dr", 21_500_000],
      ]),
    },
    {
      client: C.C, entity: "llp", status: "draft",
      ledgers: tb([
        ["Partners' capital account", "Cr", 8_000_000], ["Sundry creditors", "Cr", 1_200_000], ["Professional fees received", "Cr", 41_000_000], ["Office equipment", "Dr", 2_400_000], ["Sundry debtors", "Dr", 6_800_000],
        ["ICICI Bank", "Dr", 3_100_000], ["Salaries", "Dr", 18_400_000], ["Rent", "Dr", 3_600_000], ["Depreciation", "Dr", 480_000], ["Consultancy charges", "Dr", 9_820_000], ["Travel", "Dr", 1_600_000], ["Unmapped suspense", "Dr", 4_000_000],
      ]),
    },
  ];
  for (const f of fsPlans) {
    const stored = classifyLedgers(f.ledgers, null).map((l) => ({ name: l.name, group: l.group, debit: l.debit, credit: l.credit, row: l.row, bucket: l.bucket, matched: l.bucket !== null, source: l.classification.source, confidence: l.classification.confidence, reason: l.classification.reason }));
    const inputs: FsInputs = { ...emptyInputs(f.entity), tb: { documentId: null, fileName: `Trial_balance_FY${previousFinancialYear(fy)}.xlsx`, sheet: "TB", headerRow: 1, mapping: { ledgerName: "Ledger", group: null, debit: "Debit", credit: "Credit", balance: null }, positiveBalanceIs: "debit" } };
    const statements = rebuildStatements(stored, inputs, { financialYear: previousFinancialYear(fy), previous: null });
    await ins(db, "financial_statements", [{
      id: qid(`fs:${f.client}`), client_id: f.client, financial_year: previousFinancialYear(fy), ledgers: json(stored), statements, inputs, status: f.status, created_by: uid("E1"), prepared_by: uid("E1"),
      reviewed_by: f.status === "reviewed" ? uid("M1") : null, reviewed_at: f.status === "reviewed" ? ist(daysAgo(today, 4)) : null, created_at: ist(daysAgo(today, 12)),
    }], "");
  }
  bump(ctx, "financial_statements", fsPlans.length);

  // Notices.
  await q(db, "update public.tax_notices set notice_type = 'Scrutiny notice', section = '143(2)', authority = 'NFAC', reference_no = 'ITBA/AST/S/143(2)/2026-27/1067' || substr(md5(id::text), 1, 6), notice_date = $1, received_date = $1, reply_due_date = $2, status = 'open', tax_area = 'income_tax', financial_year = '2024-25', description = 'Large cash deposits during the year; explain the source.', assigned_employee_id = $3, created_by = $4 where client_id = $5", [daysAgo(today, 12), addDays(today, 3), emp("M2"), uid("M2"), C.A]);
  await q(db, "update public.tax_notices set notice_type = 'Scrutiny of returns', section = 'ASMT-10', authority = 'State Tax Officer, LGSTO-45', reference_no = 'ZD2910260012345', notice_date = $1, received_date = $1, reply_due_date = $2, status = 'reply_drafted', tax_area = 'gst', financial_year = '2023-24', demand_amount = 184500, description = 'Difference between GSTR-3B and GSTR-2A ITC for FY 2023-24.', assigned_employee_id = $3, created_by = $4 where client_id = $5", [daysAgo(today, 20), addDays(today, 8), emp("E1"), uid("M1"), C.B]);
  await q(db, "update public.tax_notices set notice_type = 'Intimation', section = '200A', authority = 'TRACES (CPC-TDS)', reference_no = 'CPC/2627/Q1/889211', notice_date = $1, received_date = $1, status = 'closed_favourable', tax_area = 'tds', financial_year = '2026-27', demand_amount = 0, description = 'Short deduction default for Q1; rectified by a correction statement.', closed_at = now() - interval '5 days', closed_by = $2, created_by = $2 where client_id = $3", [daysAgo(today, 60), uid("M2"), C.C]);
  await ins(db, "tax_notices", [{ id: qid("notice:hearing"), client_id: C.B, notice_type: "Show cause notice", section: "DRC-01", authority: "Joint Commissioner, Bengaluru North", reference_no: "ZD2908260098765", notice_date: daysAgo(today, 35), received_date: daysAgo(today, 34), reply_due_date: daysAgo(today, 5), hearing_date: ist(addDays(today, 4), "11:30"), status: "hearing", tax_area: "gst", financial_year: "2022-23", demand_amount: 642000, description: "Demand for ITC on blocked credits (motor vehicles).", assigned_employee_id: emp("M1"), created_by: uid("M1") }], "");
  await ins(db, "tax_notice_notes", [
    { notice_id: fid("notice:B"), client_id: C.B, noted_on: daysAgo(today, 2), kind: "note", body: "Draft reply ready with the 2A/3B reconciliation; Venkatesh to confirm the vendor list.", author_id: uid("E1") },
    { notice_id: qid("notice:hearing"), client_id: C.B, noted_on: daysAgo(today, 5), kind: "dates", body: "Reply filed on the portal; hearing fixed for next week.", author_id: uid("M1") },
  ], "");
  void today;
}

// =================================================================================================
// 14. Data protection, the audit trail, jobs, saved views, search history
// =================================================================================================

async function governance(ctx: Ctx) {
  const { db, today } = ctx;
  await q(db, "update public.privacy_notices set published_at = $1, published_by = $2, created_by = $2, change_summary = 'First notice under the DPDP Act, 2023.', is_current = true", [ist("2026-04-01", "10:00"), uid("P1")]);
  await q(db, "update public.consent_records set purposes = '{service_delivery,statutory_compliance}', given_at = $1, channel = 'portal', ip = '103.21.4.18'", [ist("2026-04-12", "19:40")]);
  await q(db, "update public.data_requests set subject = 'Rohan Gowda (Alpha Traders)', type = 'correction', status = 'in_progress', subject_type = 'client_contact', contact = 'rohan@alpha-traders.example.com', client_id = $1, details = 'Wants his mobile number corrected on our records and on the portal.', channel = 'email', received_at = $2, due_by = $3, created_by = $4", [C.A, ist(daysAgo(today, 6)), addDays(today, 24), uid("P1")]);
  await ins(db, "data_requests", [{ subject: "Former employee, Pooja Naik", type: "erasure", status: "open", subject_type: "employee", contact: "pooja.naik@example.com", details: "Asks us to delete her personal data now that she has left.", channel: "email", received_at: ist(daysAgo(today, 2)), due_by: addDays(today, 28), created_by: uid("P1") }], "");
  await q(db, "update public.data_incidents set title = 'Invoice emailed to the wrong client', description = 'An invoice for Sri Lakshmi Steel Traders was emailed to another client because of an autocomplete slip. The recipient confirmed deletion.', severity = 'low', data_categories = '{contact_details,financial}', people_affected_estimate = 1, detected_at = now() - interval '10 days', contained_at = now() - interval '10 days' + interval '3 hours', assessed_at = now() - interval '9 days', assessment = 'Low risk: one recipient, deleted on request.', root_cause = 'Email autocomplete.', actions = $1, created_by = $2", [json([
      { at: ist(daysAgo(today, 10), "15:10"), by: uid("P1"), by_name: CAST.P1!.name, text: "Recipient asked to delete the email; confirmed in writing." },
      { at: ist(daysAgo(today, 9), "11:00"), by: uid("P1"), by_name: CAST.P1!.name, text: "Turned off address autocomplete for client emails." },
    ]), uid("P1")]);

  const users: UserKey[] = ["P1", "P2", "M1", "M2", "E1", "E2", "E3", "E4"];
  const events: Row[] = [];
  for (let d = 9; d >= 0; d--) {
    for (const k of users) {
      if ((k === "E2" && d <= 1) || weekday(daysAgo(today, d)) === 7) continue;
      events.push({ event: "login_success", user_id: uid(k), user_email: U[k].email, user_role: U[k].profileRole, ip: "10.0.0.2" + users.indexOf(k), user_agent: "Mozilla/5.0 Chrome/131", action: "login", success: true, at: ist(daysAgo(today, d), "09:3" + users.indexOf(k)) });
    }
  }
  events.push(
    { event: "login_failure", user_email: "e3@taxwise.test", ip: "10.0.0.26", action: "login", success: false, error: "Invalid login credentials", at: ist(daysAgo(today, 2), "09:31") },
    { event: "credential_viewed", user_id: uid("E1"), user_email: U.E1.email, user_role: "employee", resource_type: "client_credential", resource_id: F.credential("A"), action: "credential.reveal", success: true, at: ist(daysAgo(today, 1), "12:30") },
    { event: "data_update", user_id: uid("M1"), user_email: U.M1.email, user_role: "manager", resource_type: "invoice", resource_id: qid("invoice:awaiting"), action: "invoices.submit", details: { total: "265500.00" }, success: true, at: earlierToday(today, "10:45") },
    { event: "permission_change", user_id: uid("P1"), user_email: U.P1.email, user_role: "partner", resource_type: "employee", resource_id: emp("E1"), action: "people.vault_access", details: { vault_access: true }, success: true, at: ist(daysAgo(today, 30)) },
    { event: "export_run", user_id: uid("P1"), user_email: U.P1.email, user_role: "partner", resource_type: "report", resource_id: "collections", action: "reports.export", details: { format: "xlsx" }, success: true, at: ist(daysAgo(today, 3), "18:10") },
    { event: "config_change", user_id: uid("P1"), user_email: U.P1.email, user_role: "partner", resource_type: "firm_settings", resource_id: "1", action: "settings.billing", details: { invoice_approval_limit: "100000.00" }, success: true, at: ist(daysAgo(today, 18), "16:00") },
    { event: "access_denied", user_id: uid("E4"), user_email: U.E4.email, user_role: "employee", resource_type: "page", resource_id: "/invoices", action: "page.open", success: false, at: ist(daysAgo(today, 4), "15:12") },
    { event: "file_download", user_id: uid("CA"), user_email: U.CA.email, user_role: "client", resource_type: "document", resource_id: F.docShared("A"), action: "portal.download", success: true, at: ist(daysAgo(today, 1), "20:40") },
  );
  await ins(db, "audit_logs", events, "");
  bump(ctx, "audit_logs", events.length);
  await q(db, "update public.activity_logs set description = 'Updated the address and GST scheme', at = now() - interval '6 days' where entity_id = $1", [C.A]);
  await q(db, "update public.activity_logs set description = 'Added the CFO as a contact for income tax and audit', at = now() - interval '12 days' where entity_id = $1", [C.B]);
  await q(db, "update public.activity_logs set description = 'Changed the GST scheme to QRMP', at = now() - interval '20 days' where entity_id = $1", [C.C]);
  await ins(db, "activity_logs", [
    { entity_type: "client", entity_id: C.B, action: "status_changed", description: "Marked the tax audit as applicable for FY 2025-26", user_id: uid("M2"), user_name: CAST.M2!.name, at: ist(daysAgo(today, 40)) },
    { entity_type: "invoice", entity_id: qid("invoice:awaiting"), action: "submitted", description: "Submitted the audit fee invoice for approval", user_id: uid("M1"), user_name: CAST.M1!.name, at: earlierToday(today, "10:45") },
  ], "");

  await q(db, "update public.job_runs set name = 'reminders', status = 'succeeded', started_at = now() - interval '10 hours', finished_at = now() - interval '10 hours' + interval '14 seconds', counts = '{\"sent\": 12}'");
  const jobs = ["attendance", "escalation", "invoice-reminders", "lead-follow-ups", "compliance-top-up", "register-expiries", "retainer-billing", "partner-digest", "cover-lifecycle", "receivables-sweep", "quotations"];
  await ins(db, "job_runs", jobs.flatMap((name, i) => [0, 1].map((d) => ({ name, started_at: ist(daysAgo(today, d), `0${(i % 9) + 1}:00`), finished_at: ist(daysAgo(today, d), `0${(i % 9) + 1}:01`), status: name === "partner-digest" && d === 0 ? "failed" : "succeeded", counts: { processed: 3 + i }, error: name === "partner-digest" && d === 0 ? "Email isn't configured (RESEND_API_KEY)." : null }))), "");
  await q(db, "update public.saved_views set name = 'My overdue GST work', filters = '{\"status\":[\"in_progress\",\"data_awaited\"],\"service\":\"gst\"}' where user_id = $1", [uid("P1")]);
  await q(db, "update public.saved_views set name = 'Team review queue', filters = '{\"view\":\"review\"}' where user_id = $1", [uid("M1")]);
  await ins(db, "recent_searches", [{ user_id: uid("P1"), query: "beta" }, { user_id: uid("P1"), query: "29AAKCB1111F1Z3" }, { user_id: uid("E1"), query: "alpha" }, { user_id: uid("M1"), query: "TDS" }], "");
  await q(db, "update public.onboarding_drafts set step = 2, data = $1 where user_id = $2", [json({ display_name: "Desai Interiors", entity_type: "proprietorship", email: "arun@desai-interiors.example.com" }), uid("M1")]);
}

// =================================================================================================
// The run
// =================================================================================================

function splitFixtures(): { users: string; rest: string } {
  const sql = fixtureSql();
  const marker = "insert into public.client_groups";
  const at = sql.indexOf(marker);
  if (at < 0) throw new Error("tests/db/fixtures.ts changed shape: can't find where its clients start.");
  const lineStart = sql.lastIndexOf("\n", at) + 1;
  return { users: sql.slice(0, lineStart), rest: `set search_path = public, extensions;\n${sql.slice(lineStart)}` };
}

export async function buildQaDatabase(dbName: string): Promise<Record<string, number>> {
  if ((process.env.APP_ENV ?? "").toLowerCase() === "production") throw new Error("Refusing to run with APP_ENV=production.");
  keyringFromEnv(); // fail early without CREDENTIAL_VAULT_KEY
  const started = Date.now();
  await resetDatabase(dbName, { quiet: true });
  const db = new Client({ connectionString: dbUrl(dbName), application_name: "taxwise-qa-data" });
  await db.connect();
  try {
    await db.query("set timezone = 'Asia/Kolkata'");
    const parts = splitFixtures();
    await db.query(parts.users);
    const seed = spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "scripts", "seed-staging.ts"), "--clients", "36", "--seed", "2026"], {
      cwd: ROOT,
      env: { ...process.env, STAGING_DATABASE_URL: dbUrl(dbName), APP_ENV: "development", SEED_TARGET: "" },
      encoding: "utf8",
    });
    if (seed.status !== 0) throw new Error(`scripts/seed-staging.ts failed:\n${seed.stdout}\n${seed.stderr}`);
    await db.query(parts.rest);

    const today = todayIST();
    const ctx: Ctx = { db, today, fy: financialYearOf(today), rand: createRandom(4242), clients: [], byId: new Map(), counts: {} };
    for (const line of seed.stdout.split("\n")) {
      const m = line.match(/^\s+([a-z_]+)\s+(\d+)$/);
      if (m) ctx.counts[`staging ${m[1]}`] = Number(m[2]);
    }
    await db.query("begin");
    await people(ctx);
    await firm(ctx);
    await fixtureClients(ctx);
    await loadClients(ctx);
    await work(ctx);
    await timeAndPeople(ctx);
    await growth(ctx);
    await moneySide(ctx);
    await documents(ctx);
    await communication(ctx);
    await whatsapp(ctx);
    await registers(ctx);
    await practice(ctx);
    await workpapers(ctx);
    await governance(ctx);
    await db.query("insert into public.app_meta (key, value) values ('qa_stack_loaded_at', now()::text) on conflict (key) do update set value = excluded.value");
    await db.query("commit");
    ctx.counts["seconds"] = Math.round((Date.now() - started) / 1000);
    return ctx.counts;
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

async function main() {
  const [cmd, dbName = "taxwise_qa"] = process.argv.slice(2);
  if (cmd !== "reset") {
    console.error("usage: npx tsx --conditions=react-server scripts/local-stack/qa-data.ts reset [dbName]");
    process.exit(1);
  }
  const counts = await buildQaDatabase(dbName);
  console.log(`QA data loaded into ${dbName}:`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(28)} ${v}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
