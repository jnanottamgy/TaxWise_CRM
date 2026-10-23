/**
 * Role × table matrix (§14 "for each role and each table, assert what SELECT/INSERT/UPDATE/DELETE
 * may and may not do"). The checks are generic over every table and view in `public`, against the
 * fixtures (one row per client in nearly every table), so a new table is covered automatically.
 *
 *   - anon reads nothing anywhere;
 *   - a user whose JWT role doesn't match an active profile (X, D) sees only their own rows;
 *   - every client-owned row a user can read belongs to a client they may see (§4.1, §4.6, §7.22);
 *   - money and engagement-fee tables: Partners/Managers all rows, Employees and clients none (§4.6);
 *   - Employees and clients can't insert, update or delete money rows (§4.1);
 *   - firm configuration is written by Partners only (Managers read) (§4.1, §4.6, §5.12);
 *   - deletes on client-owned tables are Partner/Manager acts (§4.6).
 */
import { describe, expect, it } from "vitest";
import { C, U, VISIBLE_CLIENTS, isDenied, setupTestDatabase, visibleCount, type Session, type TestUser, type UserKey } from "./helpers";

const db = setupTestDatabase("matrix");

type Rel = { name: string; kind: "table" | "view"; hasClientId: boolean };

async function relations(s: Session): Promise<Rel[]> {
  const rows = await s.rows<{ name: string; kind: string; has_client_id: boolean }>(
    `select c.relname as name, case when c.relkind = 'v' then 'view' else 'table' end as kind,
            exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'client_id' and not a.attisdropped) as has_client_id
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v')
     order by 1`,
  );
  return rows.map((r) => ({ name: r.name, kind: r.kind as Rel["kind"], hasClientId: r.has_client_id }));
}

/** Row counts per relation as `user` sees them (0 when the role may not read it at all). */
async function countsAs(user: TestUser, rels: Rel[]): Promise<Record<string, number>> {
  return db.asRole(user, async (s) => {
    const out: Record<string, number> = {};
    for (const r of rels) out[r.name] = visibleCount(await s.attempt(`select 1 from public.${r.name}`));
    return out;
  });
}

async function superCounts(rels: Rel[]): Promise<Record<string, number>> {
  return db.asSuper(async (s) => {
    const out: Record<string, number> = {};
    for (const r of rels) out[r.name] = Number(await s.value(`select count(*) from public.${r.name}`));
    return out;
  });
}

/** Money and engagement-fee relations (§4.1, §4.6): Partner/Manager only. */
const MONEY = [
  "invoices",
  "invoices_view",
  "invoice_items",
  "payment_receipts",
  "credit_notes",
  "invoice_follow_ups",
  "invoice_reminders",
  "tds_statement_entries",
  "quotations",
  "quotation_items",
  "quotation_email_logs",
  "quotation_follow_ups",
  "leads",
  "engagement_letters",
  "client_services",
  "client_service_fee_history",
  "client_acceptances",
  "previous_auditor_communications",
  "audit_engagements",
];

/**
 * Wave B money relations (§4.1): leads and quotations lists, acceptance register, collections,
 * retainer billing, TDS credits, GST annual returns. Partner/Manager only, so nobody else reads a
 * row (the Partner/Manager side is covered by each module's own tests: growth, invoices, collections).
 */
const MONEY_WAVE_B = [
  "leads_list",
  "quotations_list",
  "client_acceptances_list",
  "collection_forecast",
  "retainer_draft_queue",
  "retainer_runs",
  "retainer_drafts",
  "tds_credit_register",
  "tds_statement_imports",
  "tds_statement_matches",
  "gst_annual_returns",
];

/** Firm configuration written by Partners only (§4.1 settings, §5.12 law tables, §7.15.4 quality). */
const PARTNER_WRITES = [
  "firm_settings",
  "number_series",
  "statutory_parameters",
  "due_date_rules",
  "due_date_overrides",
  "section_concordance",
  "firm_whatsapp_numbers",
  "holidays",
  "quality_manual_items",
  "peer_reviews",
  "restore_drills",
  "data_incidents",
  "tax_audit_external_counts",
  "privacy_notices",
];

/** Written by Partners and Managers (Employees "use only", §4.1). */
const MANAGER_WRITES = ["job_templates", "job_template_items", "message_templates", "recurring_compliance_templates", "client_groups"];

/** SQLSTATEs that mean "refused by the access rules": privilege/RLS (42501) or a guard trigger (P0001). */
const ACCESS_REFUSALS = ["42501", "P0001"];

const STAFF_USERS: UserKey[] = ["P1", "M1", "E1", "E2", "E3", "E4"];
const LIMITED_USERS: UserKey[] = ["E1", "E2", "E3", "E4", "CA", "CB", "X", "D"];

/** INSERT a copy of an existing row (so NOT NULL / CHECK pass and only the access rules decide). */
async function copyRowSql(table: string): Promise<{ sql: string; row: unknown } | null> {
  return db.asSuper(async (s) => {
    const row = await s.value(`select row_to_json(t) from public.${table} t limit 1`);
    if (!row) return null;
    const cols = await s.rows<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' order by ordinal_position`,
      [table],
    );
    const list = cols.map((c) => `"${c.column_name}"`).join(", ");
    return { sql: `insert into public.${table} (${list}) select ${list} from json_populate_record(null::public.${table}, $1::json)`, row };
  });
}

describe("anon", () => {
  it("reads nothing from any table or view", async () => {
    const rels = await db.asSuper(relations);
    const readable = await db.asAnon(async (s) => {
      const out: string[] = [];
      for (const r of rels) {
        const a = await s.attempt(`select 1 from public.${r.name} limit 1`);
        if (!isDenied(a)) out.push(r.name);
      }
      return out;
    });
    expect(readable).toEqual([]);
  });

  it("can't write anywhere either", async () => {
    const rels = (await db.asSuper(relations)).filter((r) => r.kind === "table");
    const writable = await db.asAnon(async (s) => {
      const out: string[] = [];
      for (const r of rels) {
        if (!isDenied(await s.attempt(`delete from public.${r.name}`))) out.push(`${r.name}:delete`);
        if (!isDenied(await s.attempt(`insert into public.${r.name} default values`))) out.push(`${r.name}:insert`);
      }
      return out;
    });
    expect(writable).toEqual([]);
  });
});

describe("users without a valid role", () => {
  // X: JWT app_metadata says partner, profiles.role says employee. D: profile disabled.
  for (const key of ["X", "D"] as const) {
    it(`${key} sees only their own profile, employee row and notifications`, async () => {
      const rels = await db.asSuper(relations);
      const counts = await countsAs(U[key], rels);
      const nonZero = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
      // inbox_notifications (0172) is the caller's own notifications with needs_action: the same row.
      expect(nonZero).toEqual({ app_meta: 1, employees: 1, notifications: 1, inbox_notifications: 1, profiles: 1 });
    });
  }
});

describe("client-owned rows", () => {
  for (const key of LIMITED_USERS) {
    it(`${key} reads rows of its own clients only (${VISIBLE_CLIENTS[key].join(", ") || "none"})`, async () => {
      const rels = (await db.asSuper(relations)).filter((r) => r.hasClientId && r.name !== "client_covers");
      const allowed = VISIBLE_CLIENTS[key].map((k) => C[k]);
      const leaks = await db.asRole(U[key], async (s) => {
        const out: Record<string, number> = {};
        for (const r of rels) {
          const a = await s.attempt<{ n: string }>(
            `select count(*) as n from public.${r.name} where client_id is not null and not (client_id = any($1::uuid[]))`,
            [allowed],
          );
          const n = a.ok ? Number(a.rows[0].n) : 0;
          if (!a.ok && !isDenied(a)) throw new Error(`${r.name}: ${a.message}`);
          if (n > 0) out[r.name] = n;
        }
        return out;
      });
      expect(leaks).toEqual({});
    });
  }

  it("Employees see their own client's work (the checks above are not vacuous)", async () => {
    const expected = [
      "clients",
      "client_contacts",
      "client_kyc",
      "client_document_checklist_items",
      "client_services_public",
      "client_credentials_list",
      "client_whatsapp_groups_public",
      "client_timeline_events",
      "compliance_events",
      "compliance_events_view",
      "documents",
      "document_requests",
      "messages",
      "tasks",
      "tasks_view",
      "time_entries",
      "filing_records",
      "statutory_registrations",
      "dsc_records",
      "udin_records",
      "gst_recon_runs",
      "itr_computations",
      "financial_statements",
      "tax_notices",
      "register_portal_mappings",
    ];
    for (const key of ["E1", "E2"] as const) {
      const rels = (await db.asSuper(relations)).filter((r) => expected.includes(r.name));
      const counts = await countsAs(U[key], rels);
      expect(Object.entries(counts).filter(([, n]) => n === 0).map(([t]) => `${key}:${t}`)).toEqual([]);
    }
  });

  it("portal users see their own client through the portal tables and views", async () => {
    const expected = [
      "portal_my_client",
      "portal_invoices",
      "portal_payment_receipts",
      "portal_payment_claims",
      "portal_compliance_events",
      "portal_filing_records",
      "portal_messages",
      "documents",
      "document_requests",
      "messages",
    ];
    for (const key of ["CA", "CB"] as const) {
      const rels = (await db.asSuper(relations)).filter((r) => expected.includes(r.name));
      const counts = await countsAs(U[key], rels);
      expect(Object.entries(counts).filter(([, n]) => n === 0).map(([t]) => `${key}:${t}`)).toEqual([]);
    }
  });

  it("portal users read compliance only through the portal views, never the base tables (0175)", async () => {
    const base: Rel[] = [
      { name: "compliance_events", kind: "table", hasClientId: true },
      { name: "filing_records", kind: "table", hasClientId: true },
    ];
    for (const key of ["CA", "CB"] as const) {
      expect(await countsAs(U[key], base), key).toEqual({ compliance_events: 0, filing_records: 0 });
    }
  });

  it("Partners and Managers see every row of every client-owned table", async () => {
    // client_credentials is locked for everyone (credentials.test.ts); the portal views show the
    // signed-in client's rows only, so staff see none there.
    const rels = (await db.asSuper(relations)).filter(
      (r) => r.hasClientId && r.name !== "client_credentials" && !r.name.startsWith("portal_"),
    );
    const all = await superCounts(rels);
    // Definer views filter on is_staff(), which the superuser isn't: compare them with their base table.
    const base = await superCounts([
      { name: "client_credentials", kind: "table", hasClientId: true },
      { name: "client_services", kind: "table", hasClientId: true },
      { name: "client_whatsapp_groups", kind: "table", hasClientId: true },
    ]);
    all.client_credentials_list = base.client_credentials;
    all.client_services_public = base.client_services;
    all.client_whatsapp_groups_public = base.client_whatsapp_groups;
    // message_threads (0173) is one row per live client with messages, for staff (is_staff()).
    all.message_threads = await db.asSuper((s) =>
      s.value<number>("select count(distinct m.client_id)::int from messages m join clients c on c.id = m.client_id where c.deleted_at is null"),
    );
    // inbox_action_items (0172) is the caller's own action list (their approvals, reviews, tasks to
    // accept), not a client-owned table; comms.test.ts checks who gets which item.
    const scoped = rels.filter((r) => r.name !== "inbox_action_items");
    for (const key of ["P1", "P2", "M1", "M2"] as const) {
      const counts = await countsAs(U[key], scoped);
      const short = Object.entries(counts)
        .filter(([t, n]) => n !== all[t])
        .map(([t, n]) => `${t}: ${n} of ${all[t]}`);
      expect(short, key).toEqual([]);
    }
  });
});

describe("money and engagement fees (§4.1 'never, anywhere' for Employees)", () => {
  it("Partners and Managers read every money row", async () => {
    const rels = (await db.asSuper(relations)).filter((r) => MONEY.includes(r.name));
    const all = await superCounts(rels);
    for (const key of ["P1", "P2", "M1", "M2"] as const) {
      const counts = await countsAs(U[key], rels);
      expect(counts, key).toEqual(all);
    }
    expect(Object.values(all).every((n) => n > 0)).toBe(true);
  });

  for (const key of LIMITED_USERS) {
    it(`${key} reads no money row at all`, async () => {
      const rels = (await db.asSuper(relations)).filter((r) => MONEY.includes(r.name) || MONEY_WAVE_B.includes(r.name) || r.name === "employee_cost_rates");
      expect(rels.filter((r) => MONEY_WAVE_B.includes(r.name)).length, "every wave B money relation exists").toBe(MONEY_WAVE_B.length);
      const counts = await countsAs(U[key], rels);
      expect(Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0))).toEqual({});
    });
  }

  it("cost rates are Partner-only (§5.2): Managers get no rows and no column", async () => {
    expect(await db.asRole(U.P1, (s) => s.value<number>("select count(*)::int from employee_cost_rates"))).toBeGreaterThan(0);
    expect(await db.asRole(U.M1, (s) => s.value<number>("select count(*)::int from employee_cost_rates"))).toBe(0);
    for (const key of ["P1", "M1", "E1"] as const) {
      const e = await db.asRole(U[key], (s) => s.fails("select cost_rate_per_hour from employees"));
      expect(e.message, key).toMatch(/permission denied/);
    }
  });

  for (const key of ["E1", "E2", "CA", "CB", "X"] as const) {
    it(`${key} can't insert, update or delete money rows`, async () => {
      const tables = (await db.asSuper(relations)).filter((r) => r.kind === "table" && MONEY.includes(r.name));
      const before = await superCounts(tables);
      const allowed: string[] = [];
      for (const t of tables) {
        const copy = await copyRowSql(t.name);
        await db.asRole(U[key], async (s) => {
          if (copy) {
            const ins = await s.attempt(copy.sql, [JSON.stringify(copy.row)]);
            if (ins.ok) allowed.push(`${t.name}:insert`);
            // refused by the access rules, not by a constraint (which would make the check vacuous)
            else if (!ACCESS_REFUSALS.includes(ins.code)) allowed.push(`${t.name}:insert inconclusive (${ins.code} ${ins.message})`);
          }
          const upd = await s.attempt(`update public.${t.name} set id = id`);
          if (upd.ok && upd.rowCount > 0) allowed.push(`${t.name}:update(${upd.rowCount})`);
          const del = await s.attempt(`delete from public.${t.name}`);
          if (del.ok && del.rowCount > 0) allowed.push(`${t.name}:delete(${del.rowCount})`);
        });
      }
      expect(allowed).toEqual([]);
      expect(await superCounts(tables)).toEqual(before);
    });
  }
});

describe("firm configuration", () => {
  const cases: { table: string; writers: UserKey[] }[] = [
    ...PARTNER_WRITES.map((table) => ({ table, writers: ["P1"] as UserKey[] })),
    ...MANAGER_WRITES.map((table) => ({ table, writers: ["P1", "M1"] as UserKey[] })),
  ];

  it("staff read the configuration they work with", async () => {
    const shared = ["firm_settings", "statutory_parameters", "due_date_rules", "due_date_overrides", "section_concordance",
      "firm_whatsapp_numbers", "holidays", "job_templates", "job_template_items", "message_templates",
      "recurring_compliance_templates", "client_groups", "employee_directory"];
    const rels = (await db.asSuper(relations)).filter((r) => shared.includes(r.name));
    for (const key of STAFF_USERS) {
      const counts = await countsAs(U[key], rels);
      expect(Object.entries(counts).filter(([, n]) => n === 0).map(([t]) => `${key}:${t}`)).toEqual([]);
    }
    // … and portal users don't
    for (const key of ["CA", "CB"] as const) {
      const counts = await countsAs(U[key], rels);
      expect(Object.values(counts).every((n) => n === 0), key).toBe(true);
    }
  });

  for (const { table, writers } of cases) {
    it(`${table}: written only by ${writers.join(" and ")}`, async () => {
      const copy = await copyRowSql(table);
      for (const key of ["P1", "M1", "E1", "CA"] as UserKey[]) {
        const mayWrite = writers.includes(key);
        await db.asRole(U[key], async (s) => {
          const upd = await s.attempt(`update public.${table} set updated_at = updated_at`);
          const updated = upd.ok ? upd.rowCount : 0;
          if (mayWrite) expect(updated, `${key} update ${table}`).toBeGreaterThan(0);
          else expect(updated, `${key} update ${table}`).toBe(0);

          if (copy && !mayWrite) {
            const ins = await s.attempt(copy.sql, [JSON.stringify(copy.row)]);
            expect(ins.ok, `${key} insert ${table}`).toBe(false);
            if (!ins.ok) expect(ACCESS_REFUSALS, `${key} insert ${table}: ${ins.message}`).toContain(ins.code);
          }
          if (!mayWrite) {
            const del = await s.attempt(`delete from public.${table}`);
            expect(del.ok ? del.rowCount : 0, `${key} delete ${table}`).toBe(0);
          }
        });
      }
    });
  }
});

describe("deletes on client-owned tables", () => {
  /** Employees may delete their own time entries (§7.10); nothing else client-owned. */
  const EMPLOYEE_DELETES = new Set(["time_entries"]);

  for (const key of ["E1", "E2", "E4", "CA", "CB"] as const) {
    it(`${key} deletes nothing client-owned (Partner/Manager act)`, async () => {
      const tables = (await db.asSuper(relations)).filter((r) => r.kind === "table" && r.hasClientId);
      const deleted = await db.asRole(U[key], async (s) => {
        const out: string[] = [];
        for (const t of tables) {
          if (EMPLOYEE_DELETES.has(t.name) && key.startsWith("E")) continue;
          const a = await s.attempt(`delete from public.${t.name}`);
          if (a.ok && a.rowCount > 0) out.push(`${t.name}(${a.rowCount})`);
          if (!a.ok && !isDenied(a) && a.code !== "P0001" && a.code !== "23503") throw new Error(`${t.name}: ${a.message}`);
        }
        return out;
      });
      expect(deleted).toEqual([]);
    });
  }

  it("a Manager can delete a client-owned row; only a Partner purges a client", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(await s.exec("delete from client_contacts where client_id = $1", [C.C])).toBe(1);
      expect(await s.exec("delete from clients where id = $1", [C.C])).toBe(0);
    });
    await db.asRole(U.P1, async (s) => {
      const a = await s.attempt("delete from clients where id = $1", [C.Z]);
      // the Partner's purge is allowed by RLS; restrict FKs (invoices) may still stop it
      expect(a.ok || a.code === "23503").toBe(true);
    });
  });
});
