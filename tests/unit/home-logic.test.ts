import { describe, expect, it } from "vitest";
import {
  agendaHref,
  count,
  deadlineHref,
  filingStatusByReturnType,
  firmFinding,
  joinFinding,
  myDayFinding,
  returnTypeKey,
  returnTypeLabel,
  teamFinding,
  teamLoadRows,
  workHref,
} from "@/components/home/logic";
import { assessCapacity, CAPACITY_DEFAULTS } from "@/lib/domain/capacity";
import { parseTableParams } from "@/components/app/data-table/params";
import { OPEN_TASK_STATUSES, WORK_FILTERS, WORK_SORTABLE } from "@/lib/schemas/tasks";
import { toPaise } from "@/lib/domain/money";

const TODAY = "2026-10-23";

describe("home page wording", () => {
  it("counts with the right noun", () => {
    expect(count(1, "task")).toBe("1 task");
    expect(count(3, "task")).toBe("3 tasks");
    expect(count(2, "person", "people")).toBe("2 people");
    expect(count(12345, "client")).toBe("12,345 clients");
  });

  it("joins only what is there", () => {
    expect(joinFinding(["a", null, false, "", "b"])).toBe("a · b");
    expect(joinFinding([null, false])).toBeNull();
  });

  it("puts what waits on the person first on My day", () => {
    expect(myDayFinding({ waiting: 2, sentBack: 1, overdue: 3, dueToday: 1, review: 0 })).toBe(
      "1 task sent back to you · 2 tasks waiting for you to accept · 3 overdue · 1 due today",
    );
    expect(myDayFinding({ waiting: 0, sentBack: 0, overdue: 0, dueToday: 0, review: 0 })).toBe("Nothing is overdue, due today or waiting on you.");
  });

  it("leads Team today with work to reassign", () => {
    expect(teamFinding({ unassigned: 4, declined: 1, waiting: 0, overdue: 2, overCapacity: 1 })).toBe(
      "1 declined task to reassign · 4 unassigned · 2 tasks overdue · 1 person over capacity",
    );
    expect(teamFinding({ unassigned: 0, declined: 0, waiting: 0, overdue: 0, overCapacity: 0 })).toBe("Nothing is unassigned, declined or overdue.");
  });

  it("leads Firm today with decisions, then money and filings", () => {
    expect(firmFinding({ approvals: 3, overdueCount: 5, overduePaise: toPaise("240000"), filingsDueIn7: 4, overdueTasks: 0 })).toBe(
      "3 approvals waiting for you · ₹2.4L overdue on 5 invoices · 4 filings due in 7 days",
    );
    expect(firmFinding({ approvals: 0, overdueCount: 0, overduePaise: 0, filingsDueIn7: 0, overdueTasks: 0 })).toMatch(/^No approvals waiting/);
  });
});

describe("filing status by return type", () => {
  it("maps deadlines to the filings grid's return types", () => {
    expect(returnTypeKey({ type: "gstr_3b", form_code: "GSTR-3B", rule_code: null })).toBe("gstr_3b");
    expect(returnTypeKey({ type: "gstr_3b", form_code: "PMT-06", rule_code: null })).toBe("pmt_06");
    expect(returnTypeKey({ type: "tds", form_code: "26Q", rule_code: null })).toBe("tds_return");
    expect(returnTypeKey({ type: "tds", form_code: null, rule_code: "TDS_RETURN_Q2" })).toBe("tds_return");
    expect(returnTypeKey({ type: "custom", form_code: "Board meeting", rule_code: null })).toBe("other");
    expect(returnTypeLabel("gstr_1")).toBe("GSTR-1");
    expect(returnTypeLabel("other")).toBe("Other");
  });

  it("counts filed, pending and overdue in the grid's order, Other last", () => {
    const rows = filingStatusByReturnType(
      [
        { type: "custom", form_code: "Board meeting", rule_code: null, status: "pending", due_date: "2026-10-30" },
        { type: "gstr_3b", form_code: "GSTR-3B", rule_code: null, status: "completed", due_date: "2026-10-20" },
        { type: "gstr_3b", form_code: "GSTR-3B", rule_code: null, status: "pending", due_date: "2026-10-20" },
        { type: "gstr_1", form_code: "GSTR-1", rule_code: null, status: "pending", due_date: "2026-10-23" },
        { type: "gstr_1", form_code: "GSTR-1", rule_code: null, status: "cancelled", due_date: "2026-10-11" },
      ],
      TODAY,
    );
    expect(rows.map((r) => [r.type, r.filed, r.pending, r.overdue])).toEqual([
      ["gstr_3b", 1, 0, 1],
      ["gstr_1", 0, 1, 0],
      ["other", 0, 1, 0],
    ]);
    expect(rows[0]).toMatchObject({ label: "GSTR-3B", href: "/filings?type=gstr_3b" });
    expect(rows[2].href).toBeNull();
  });
});

describe("home page links", () => {
  const read = (href: string) => {
    const [path, qs] = href.split("?");
    return { path, t: parseTableParams(new URLSearchParams(qs ?? ""), { sortable: WORK_SORTABLE, filters: WORK_FILTERS }) };
  };

  it("land on the work tracker filtered to the queue they count", () => {
    expect(read(workHref.unassigned()).t.filters).toEqual({ assignee: ["none"], status: [...OPEN_TASK_STATUSES] });
    expect(read(workHref.declined()).t.filters).toEqual({ acceptance: ["declined"], assignee: ["none"], status: [...OPEN_TASK_STATUSES] });
    expect(read(workHref.waiting()).t.filters).toEqual({ acceptance: ["pending"], status: [...OPEN_TASK_STATUSES] });
    expect(read(workHref.dataAwaited()).t.filters).toEqual({ status: ["data_awaited"] });
    expect(read(workHref.overdue()).t.filters).toEqual({ due: ["overdue"] });
    expect(read(workHref.overdueFor("e1")).t.filters).toEqual({ due: ["overdue"], assignee: ["e1"] });
    expect(read(workHref.overdueFor(null)).t.filters).toEqual({ due: ["overdue"], assignee: ["none"] });
    expect(read(workHref.myWaiting()).t.filters).toEqual({ assignee: ["me"], acceptance: ["pending"], status: [...OPEN_TASK_STATUSES] });
    expect(read(workHref.myOpen()).t).toMatchObject({ sort: "due_date", dir: "asc", filters: { assignee: ["me"], status: [...OPEN_TASK_STATUSES] } });
    expect(workHref.review()).toBe("/work?view=review");
  });

  it("open deadlines in the calendar agenda", () => {
    expect(deadlineHref({ id: "e1", due_date: "2026-10-20" })).toBe("/calendar?view=agenda&date=2026-10-20&event=e1");
    expect(agendaHref(TODAY)).toBe("/calendar?view=agenda&date=2026-10-23");
  });
});

describe("the team: capacity and overdue work", () => {
  const cap = (open: number) => assessCapacity(open, 10, CAPACITY_DEFAULTS);

  it("puts the most overdue first, then the most loaded, and keeps people who left with overdue work", () => {
    const rows = teamLoadRows(
      [
        { id: "a", name: "Anita", capacity: cap(5) },
        { id: "b", name: "Bharat", capacity: cap(45) },
        { id: "c", name: "Chitra", capacity: cap(20) },
        { id: "d", name: "Deepak", capacity: cap(5) },
      ],
      [
        { employeeId: "c", name: "Chitra", count: 2 },
        { employeeId: "x", name: "Former colleague", count: 4 },
        { employeeId: null, name: "Unassigned", count: 7 },
      ],
    );
    expect(rows.map((r) => [r.id, r.overdue, r.capacity?.band ?? null])).toEqual([
      ["x", 4, null],
      ["c", 2, "busy"],
      ["b", 0, "over"],
      ["a", 0, "clear"],
      ["d", 0, "clear"],
    ]);
  });

  it("is empty with no one active and nothing overdue", () => {
    expect(teamLoadRows([], [])).toEqual([]);
  });
});
