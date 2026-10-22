/**
 * next_document_number (§0.1 rule 6, §5.11, §6.4, §14 "number series (≤16 chars; FY rollover;
 * concurrency)"): formats, FY reset, the Rule 46 length limit, permissions, and that concurrent
 * transactions never get the same number and a rolled-back number is reused (no gaps).
 */
import { describe, expect, it } from "vitest";
import { planNextNumber, type SeriesKey } from "@/lib/domain/numbering";
import { SQLSTATE, U, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("numbering", { fixtures: true });

const take = (s: Session, key: string, date: string | null = "2026-10-22") =>
  s.value<string>("select next_document_number($1, $2::date)", [key, date]);
const refusal = async (s: Session, key: string, date: string | null = "2026-10-22") =>
  userMessage(await s.fails("select next_document_number($1, $2::date)", [key, date]));
const seqOf = (n: string) => Number(n.split(/[/-]/).pop());

async function setSeries(s: Session, key: string, next: number, fy: string | null) {
  await s.as("super");
  await s.exec("update number_series set next_value = $2, financial_year = $3 where key = $1", [key, next, fy]);
}

describe("formats (§5.11)", () => {
  it("every series has its documented shape and counts up by one", async () => {
    await db.asRole(U.P1, async (s) => {
      const shapes: Record<string, RegExp> = {
        invoice: /^TW\/26-27\/\d{4}$/,
        credit_note: /^TW-CN\/26-27\/\d{4}$/,
        quotation: /^TW-Q\/26-27\/\d{4}$/,
        receipt: /^TW-R\/26-27\/\d{4}$/,
        client_code: /^TW-C-\d{4}$/,
        task: /^T-\d{6}$/,
        lead: /^L-\d{4}$/,
      };
      for (const [key, shape] of Object.entries(shapes)) {
        const a = await take(s, key);
        const b = await take(s, key);
        expect(a, key).toMatch(shape);
        expect(seqOf(b) - seqOf(a), key).toBe(1);
        expect(a.length, key).toBeLessThanOrEqual(16);
      }
    });
  });

  it("agrees with planNextNumber() in lib/domain/numbering.ts, refusals included", async () => {
    type Case = { key: SeriesKey; next: number; fy: string | null; date: string; prefix?: string };
    const cases: Case[] = [
      { key: "invoice", next: 42, fy: "2026-27", date: "2026-10-22" },
      { key: "invoice", next: 42, fy: "2026-27", date: "2027-04-01" },
      { key: "invoice", next: 42, fy: "2027-28", date: "2027-03-31" },
      { key: "invoice", next: 1, fy: null, date: "2026-10-22" },
      { key: "invoice", next: 3, fy: "2026-27", date: "2026-10-22", prefix: "TWCBLR" },
      { key: "credit_note", next: 99999, fy: "2026-27", date: "2026-10-22" },
      { key: "quotation", next: 7, fy: "2025-26", date: "2026-04-01" },
      { key: "receipt", next: 12, fy: "2026-27", date: "2027-03-31" },
      { key: "client_code", next: 5, fy: null, date: "2027-04-01" },
      { key: "client_code", next: 5, fy: null, date: "2027-04-01", prefix: "TAXWISE-CLIENTS" },
      // prefixes are trimmed, and refused (before the FY check) when Rule 46 doesn't allow them
      { key: "invoice", next: 3, fy: "2026-27", date: "2026-10-22", prefix: " TWC " },
      { key: "invoice", next: 3, fy: "2026-27", date: "2026-10-22", prefix: "TW#1" },
      { key: "receipt", next: 3, fy: "2027-28", date: "2026-10-22", prefix: "TW R" },
      { key: "client_code", next: 5, fy: null, date: "2026-10-22", prefix: "   " },
      { key: "task", next: 123, fy: null, date: "2026-10-22" },
      { key: "lead", next: 10000, fy: null, date: "2026-10-22" },
    ];
    const prefixColumn: Partial<Record<SeriesKey, string>> = {
      invoice: "invoice_prefix", credit_note: "credit_note_prefix", quotation: "quotation_prefix", receipt: "receipt_prefix", client_code: "client_code_prefix",
    };
    for (const c of cases) {
      await db.asSuper(async (s) => {
        await setSeries(s, c.key, c.next, c.fy);
        if (c.prefix) await s.exec(`update firm_settings set ${prefixColumn[c.key]} = $1`, [c.prefix]);
        await s.as(U.P1);
        const got = await s.attempt<{ n: string }>("select next_document_number($1, $2::date) as n", [c.key, c.date]);
        const want = planNextNumber(c.key, { nextValue: c.next, financialYear: c.fy }, { date: c.date, prefix: c.prefix });
        const label = JSON.stringify(c);
        expect(got.ok, label).toBe(want.ok);
        if (got.ok && want.ok) expect(got.rows[0].n, label).toBe(want.number);
        if (!got.ok && !want.ok) expect(got.message.replace(/^USER: /, ""), label).toBe(want.error);
      });
    }
  });

  it("prefixes come from firm_settings (task and lead are fixed)", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set invoice_prefix = 'TWC', client_code_prefix = 'BLR'");
      await setSeries(s, "invoice", 7, "2026-27");
      await setSeries(s, "client_code", 12, null);
      await s.as(U.M1);
      expect(await take(s, "invoice")).toBe("TWC/26-27/0007");
      expect(await take(s, "client_code")).toBe("BLR-0012");
    });
  });

  it("the sequence is zero-padded, never truncated", async () => {
    await db.asSuper(async (s) => {
      await setSeries(s, "invoice", 10000, "2026-27");
      await setSeries(s, "task", 1234567, null);
      await s.as(U.P1);
      expect(await take(s, "invoice")).toBe("TW/26-27/10000");
      expect(await take(s, "task")).toBe("T-1234567");
    });
  });

  it("a missing series row is created at 1", async () => {
    await db.asSuper(async (s) => {
      await s.exec("delete from number_series where key = 'lead'");
      await s.as(U.P1);
      expect(await take(s, "lead")).toBe("L-0001");
      expect(await take(s, "lead")).toBe("L-0002");
    });
  });

  it("refuses an unknown series and a prefix with characters Rule 46 doesn't allow", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.P1);
      expect(await refusal(s, "salary_slip")).toMatch(/There is no number series called "salary_slip"/);
      await s.as("super");
      await s.exec("update firm_settings set invoice_prefix = 'TW#1'");
      await s.as(U.P1);
      expect(await refusal(s, "invoice")).toMatch(/can use only letters, digits, - and \//);
    });
  });
});

describe("financial-year reset (§6.3, §5.11)", () => {
  it("FY-scoped series restart at 1 in a new FY and refuse a date in an earlier FY", async () => {
    await db.asSuper(async (s) => {
      await setSeries(s, "invoice", 57, "2026-27");
      await setSeries(s, "receipt", 9, "2026-27");
      await s.as(U.P1);
      expect(await take(s, "invoice", "2027-03-31")).toBe("TW/26-27/0057");
      expect(await take(s, "invoice", "2027-04-01")).toBe("TW/27-28/0001");
      expect(await take(s, "invoice", "2027-05-15")).toBe("TW/27-28/0002");
      expect(await refusal(s, "invoice", "2027-03-31")).toBe(
        "The invoice series has moved on to FY 2027-28, so it can't number a document dated in FY 2026-27.",
      );
      // the other series are independent
      expect(await take(s, "receipt", "2027-03-31")).toBe("TW-R/26-27/0009");
      await s.as("super");
      expect(await s.value("select financial_year from number_series where key = 'invoice'")).toBe("2027-28");
    });
  });

  it("series without an FY never reset", async () => {
    await db.asSuper(async (s) => {
      await setSeries(s, "client_code", 31, null);
      await s.as(U.P1);
      expect(await take(s, "client_code", "2027-04-01")).toBe("TW-C-0031");
      expect(await take(s, "client_code", "2026-05-01")).toBe("TW-C-0032");
    });
  });

  it("uses today in IST when no date is given", async () => {
    await db.asRole(U.P1, async (s) => {
      const today = await s.value<string>("select financial_year_label(today_ist())");
      const n = await take(s, "credit_note", null);
      expect(n).toContain(`/${today.slice(2, 4)}-${today.slice(5, 7)}/`);
    });
  });
});

describe("GST Rule 46: at most 16 characters (§0.1 rule 6, §6.4)", () => {
  it("16 characters is accepted; 17 is refused with the reason", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set invoice_prefix = 'TWCBL'"); // 5 + '/26-27/' (7) + 4 = 16
      await setSeries(s, "invoice", 1, "2026-27");
      await s.as(U.P1);
      const n = await take(s, "invoice");
      expect(n).toBe("TWCBL/26-27/0001");
      expect(n).toHaveLength(16);
      await s.as("super");
      await s.exec("update firm_settings set invoice_prefix = 'TWCBLR'");
      await s.as(U.P1);
      expect(await refusal(s, "invoice")).toBe(
        "The next invoice number (TWCBLR/26-27/0002) would be longer than 16 characters. Shorten the prefix in Settings → Numbering.",
      );
      // the refused attempt consumed nothing
      await s.as("super");
      expect(await s.value("select next_value from number_series where key = 'invoice'")).toBe(2);
    });
  });

  it("a counter that outgrows 16 characters is refused too, for every series", async () => {
    await db.asSuper(async (s) => {
      await setSeries(s, "credit_note", 1_000_000, "2026-27"); // TW-CN/26-27/1000000 = 19
      await s.exec("update firm_settings set client_code_prefix = 'TAXWISE-CLIENTS'"); // 15 + '-0001'
      await s.as(U.P1);
      expect(await refusal(s, "credit_note")).toMatch(/longer than 16 characters/);
      expect(await refusal(s, "client_code")).toMatch(/longer than 16 characters/);
    });
  });

  it("the limit follows the statutory parameter when one is in force (§5.12)", async () => {
    await db.asSuper(async (s) => {
      await s.exec(`insert into statutory_parameters (key, value, effective_from, verified) values ('gst.invoice_number_max_length', '14', '2017-07-01', true)`);
      await setSeries(s, "invoice", 1, "2026-27");
      await s.as(U.P1);
      expect(await take(s, "invoice")).toBe("TW/26-27/0001"); // 13
      await s.as("super");
      await setSeries(s, "invoice", 10000, "2026-27");
      await s.exec("update firm_settings set invoice_prefix = 'TWX'");
      await s.as(U.P1);
      expect(await refusal(s, "invoice")).toMatch(/longer than 14 characters/);
    });
  });
});

describe("who may take a number (§5.11)", () => {
  it("Partners, Managers and the service role; not Employees, clients or anon", async () => {
    expect(await db.asRole(U.M1, (s) => take(s, "quotation"))).toMatch(/^TW-Q\//);
    for (const user of [U.E1, U.CA, U.X, U.D]) {
      expect(await db.asRole(user, (s) => refusal(s, "invoice")), user.key).toBe("You don't have permission to take a document number.");
    }
    expect((await db.asAnon((s) => s.fails("select next_document_number('invoice')"))).code).toBe(SQLSTATE.insufficientPrivilege);
    await db.asSuper(async (s) => {
      await s.exec("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
      await s.exec("set local role service_role");
      expect(await take(s, "receipt")).toMatch(/^TW-R\//);
    });
  });

  it("Employees can't move the counters directly either", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.value<number>("select count(*)::int from number_series")).toBe(0);
      expect(await s.exec("update number_series set next_value = 1")).toBe(0);
    });
    await db.asRole(U.M1, async (s) => {
      expect(await s.exec("update number_series set next_value = 1")).toBe(0); // Partners edit Settings → Numbering
    });
  });
});

describe("concurrency (§0.1 rule 6: the locked counter)", () => {
  it("two concurrent transactions get different numbers; the second waits for the first", async () => {
    const a = await db.openSession(U.P1);
    const b = await db.openSession(U.M1);
    try {
      const first = await take(a, "invoice");
      let secondDone = false;
      const second = take(b, "invoice").then((n) => {
        secondDone = true;
        return n;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(secondDone).toBe(false); // blocked on the row lock
      await a.commit();
      const n2 = await second;
      expect(n2).not.toBe(first);
      expect(seqOf(n2)).toBe(seqOf(first) + 1);
      await b.commit();
    } finally {
      await a.rollback();
      await b.rollback();
    }
  });

  it("a rolled-back number is handed to the next transaction (no gap)", async () => {
    const a = await db.openSession(U.P1);
    const b = await db.openSession(U.P1);
    try {
      const first = await take(a, "receipt");
      const second = take(b, "receipt");
      await new Promise((r) => setTimeout(r, 200));
      await a.rollback();
      expect(await second).toBe(first);
      await b.commit();
    } finally {
      await a.rollback();
      await b.rollback();
    }
  });

  it("many parallel transactions with some rollbacks give unique, contiguous numbers", async () => {
    const start = await db.asSuper((s) => s.value<number>("select next_value from number_series where key = 'quotation'"));
    const results = await Promise.all(
      Array.from({ length: 16 }, async (_, i) => {
        const s = await db.openSession(i % 2 ? U.P1 : U.M1);
        try {
          const n = await take(s, "quotation");
          if (i % 5 === 4) {
            await s.rollback();
            return null;
          }
          await s.commit();
          return n;
        } catch (err) {
          await s.rollback();
          throw err;
        }
      }),
    );
    const committed = results.filter((n): n is string => n !== null);
    expect(new Set(committed).size).toBe(committed.length);
    const seqs = committed.map(seqOf).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: committed.length }, (_, i) => start + i));
  });
});
