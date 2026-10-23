/**
 * People (§4.1, §4.5, §4.7, §7.1, §7.11, §7.12): the staff lifecycle functions and guards of
 * migrations 0105–0107 — open-work checks, reassign_all_work, set_staff_active, delete_staff,
 * change_staff_email, revoke_auth_sessions, people_overview, profile images, attendance
 * corrections, leave decisions with attendance marking, one open presence session, and the cover
 * merge on insert.
 */
import { describe, expect, it } from "vitest";
import { C, F, SQLSTATE, U, setupTestDatabase, userMessage, type Session, type TestUser } from "./helpers";

const db = setupTestDatabase("people");

const uuid = () => crypto.randomUUID();

async function employeeUpdatedAt(s: Session, who: TestUser): Promise<string> {
  return s.value<string>("select updated_at::text from employees where id = $1", [who.employeeId]);
}

async function openWork(s: Session, who: TestUser): Promise<Record<string, number>> {
  return s.value<Record<string, number>>("select employee_open_work($1)", [who.employeeId]);
}

let taskSeq = 0;
async function newTask(s: Session, opts: { client?: string; assignee?: TestUser | null; reviewer?: TestUser | null; status?: string }): Promise<string> {
  return s.value<string>(
    `insert into tasks (task_number, client_id, title, status, assigned_employee_id, reviewer_employee_id, acceptance_status, created_by)
     values ($1, $2, $3, $4::task_status, $5, $6, 'accepted', $7) returning id`,
    [
      `T-7${String(++taskSeq).padStart(5, "0")}`,
      opts.client ?? C.A,
      `People test task ${taskSeq}`,
      opts.status ?? "in_progress",
      opts.assignee === undefined ? U.E1.employeeId : (opts.assignee?.employeeId ?? null),
      opts.reviewer?.employeeId ?? null,
      U.P1.id,
    ],
  );
}

// -------------------------------------------------------------------------------------------------
// Open work and the disable / delete block (§4.5 points 6–7)
// -------------------------------------------------------------------------------------------------

describe("open work (§4.5)", () => {
  it("counts open tasks, review items and clients; Employees ask only about themselves", async () => {
    await db.asRole(U.M1, async (s) => {
      const w = await openWork(s, U.E1);
      expect(w.open_tasks).toBe(1);
      expect(w.owned_clients).toBe(1); // client A; Z is in the recycle bin
      expect(w.review_tasks).toBe(0);
    });
    await db.asRole(U.E1, async (s) => {
      const w = await openWork(s, U.E1);
      expect(w.open_tasks).toBe(1);
      expect(w.open_leads).toBe(0);
      expect(userMessage(await s.fails("select employee_open_work($1)", [U.E2.employeeId]))).toMatch(/Only Partners and Managers/);
    });
  });

  it("nobody can disable or delete a person who holds open tasks, not even the service role", async () => {
    await db.asSuper(async (s) => {
      expect(userMessage(await s.fails("update employees set is_active = false where id = $1", [U.E1.employeeId]))).toBe(
        "Test E1 still holds 1 open task. Reassign their work first.",
      );
      expect(userMessage(await s.fails("update employees set deleted_at = now() where id = $1", [U.E1.employeeId]))).toMatch(/Reassign their work first/);
      await newTask(s, { assignee: U.E4, reviewer: U.E3, client: C.B });
      expect(userMessage(await s.fails("update employees set is_active = false where id = $1", [U.E3.employeeId]))).toBe(
        "Test E3 still holds 1 task to review. Reassign their work first.",
      );
    });
  });
});

// -------------------------------------------------------------------------------------------------
// set_staff_active / delete_staff
// -------------------------------------------------------------------------------------------------

describe("set_staff_active (§4.5 point 6)", () => {
  it("a Manager disables an Employee: record and profile together, covers end, the open session closes", async () => {
    await db.asSuper(async (s) => {
      const cover = await s.value<string>(
        `insert into client_covers (kind, client_id, absent_employee_id, cover_employee_id, ends_at, reason, granted_by)
         values ('client', $1, $2, $3, now() + interval '1 day', 'leave', $4) returning id`,
        [C.A, U.E1.employeeId, U.E3.employeeId, U.P1.id],
      );
      await s.exec("insert into employee_sessions (employee_id, user_id, last_active_at, active_minutes) values ($1, $2, now() - interval '10 minutes', 30)", [U.E3.employeeId, U.E3.id]);
      await s.as(U.M1);
      const token = await employeeUpdatedAt(s, U.E3);
      const r = await s.value<Record<string, unknown>>("select set_staff_active($1, false, $2::timestamptz)", [U.E3.employeeId, token]);
      expect(r.covers_ended).toBe(1);
      expect(r.sessions_closed).toBe(1);
      await s.as("super");
      expect(await s.value("select is_active from profiles where id = $1", [U.E3.id])).toBe(false);
      expect(await s.value("select is_active from employees where id = $1", [U.E3.employeeId])).toBe(false);
      expect(await s.value("select revoke_reason from client_covers where id = $1", [cover])).toBe("Account disabled");
      const session = await s.one<{ is_active: boolean; closed_reason: string; duration_minutes: number }>(
        "select is_active, closed_reason, duration_minutes from employee_sessions where employee_id = $1",
        [U.E3.employeeId],
      );
      expect(session).toEqual({ is_active: false, closed_reason: "logout", duration_minutes: 30 });
      await s.as(U.E3);
      expect(await s.value("select app_role()::text")).toBeNull();
      // and back on
      await s.as(U.M1);
      const token2 = await employeeUpdatedAt(s, U.E3);
      await s.value("select set_staff_active($1, true, $2::timestamptz)", [U.E3.employeeId, token2]);
      await s.as(U.E3);
      expect(await s.value("select app_role()::text")).toBe("employee");
    });
  });

  it("refuses: Managers on Partners/Managers, yourself, a stale token, open work, and the last Partner", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(userMessage(await s.fails("select set_staff_active($1, false, $2::timestamptz)", [U.M2.employeeId, await employeeUpdatedAt(s, U.M2)]))).toMatch(
        /Only a Partner can disable or enable a Manager/,
      );
      expect(userMessage(await s.fails("select set_staff_active($1, false, $2::timestamptz)", [U.M1.employeeId, await employeeUpdatedAt(s, U.M1)]))).toMatch(
        /your own account/,
      );
      expect(userMessage(await s.fails("select set_staff_active($1, false, '2020-01-01T00:00:00Z'::timestamptz)", [U.E3.employeeId]))).toMatch(/changed at .* Reload/);
      expect(userMessage(await s.fails("select set_staff_active($1, false, $2::timestamptz)", [U.E1.employeeId, await employeeUpdatedAt(s, U.E1)]))).toMatch(
        /still holds 1 open task/,
      );
    });
    await db.asSuper(async (s) => {
      await s.exec("update employees set is_active = false where id = $1", [U.P1.employeeId]); // P1 keeps an active profile
      await s.as(U.P1);
      expect(userMessage(await s.fails("select set_staff_active($1, false, $2::timestamptz)", [U.P2.employeeId, await employeeUpdatedAt(s, U.P2)]))).toMatch(
        /only active Partner/,
      );
    });
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select set_staff_active($1, false, now())", [U.E3.employeeId]))).toMatch(/Only Partners and Managers/);
    });
  });
});

describe("delete_staff (§4.5 point 7)", () => {
  it("Partner only, soft, with the open-work check", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(userMessage(await s.fails("select delete_staff($1, $2::timestamptz)", [U.E3.employeeId, await employeeUpdatedAt(s, U.E3)]))).toMatch(/Only a Partner/);
    });
    await db.asRole(U.P1, async (s) => {
      expect(userMessage(await s.fails("select delete_staff($1, $2::timestamptz)", [U.E1.employeeId, await employeeUpdatedAt(s, U.E1)]))).toMatch(/Reassign their work first/);
      expect(userMessage(await s.fails("select delete_staff($1, $2::timestamptz)", [U.P1.employeeId, await employeeUpdatedAt(s, U.P1)]))).toMatch(/your own record/);
      await s.value("select delete_staff($1, $2::timestamptz)", [U.E3.employeeId, await employeeUpdatedAt(s, U.E3)]);
      const row = await s.one<{ deleted: boolean; is_active: boolean }>("select deleted_at is not null as deleted, is_active from employees where id = $1", [U.E3.employeeId]);
      expect(row).toEqual({ deleted: true, is_active: false });
      expect(await s.value<number>("select count(*)::int from people_overview where id = $1", [U.E3.employeeId])).toBe(0);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// reassign_all_work (§4.5 point 6)
// -------------------------------------------------------------------------------------------------

describe("reassign_all_work (§4.5)", () => {
  it("moves open tasks, ownership, reviewer places and team places, and logs it", async () => {
    await db.asSuper(async (s) => {
      const reviewed = await newTask(s, { assignee: U.E4, reviewer: U.E1, client: C.B });
      const clash = await newTask(s, { assignee: U.E1, reviewer: U.E3, client: C.A });
      const filed = await newTask(s, { assignee: U.E1, status: "filed_done" });
      await s.as(U.M1);
      const r = await s.value<Record<string, number>>("select reassign_all_work($1, $2)", [U.E1.employeeId, U.E3.employeeId]);
      expect(r.tasks).toBe(2); // the fixture task and `clash`; the filed one stays
      expect(r.tasks_reviewer_cleared).toBe(1);
      expect(r.reviews).toBe(1);
      expect(r.clients).toBe(1);
      await s.as("super");
      const fixtureTask = await s.one<{ assigned_employee_id: string; acceptance_status: string }>(
        "select assigned_employee_id, acceptance_status::text from tasks where id = $1",
        [F.task("A")],
      );
      expect(fixtureTask).toEqual({ assigned_employee_id: U.E3.employeeId, acceptance_status: "pending" });
      expect(await s.value("select reviewer_employee_id from tasks where id = $1", [clash])).toBeNull();
      expect(await s.value("select reviewer_employee_id from tasks where id = $1", [reviewed])).toBe(U.E3.employeeId);
      expect(await s.value("select assigned_employee_id from tasks where id = $1", [filed])).toBe(U.E1.employeeId);
      expect(await s.value("select owner_employee_id from clients where id = $1", [C.A])).toBe(U.E3.employeeId);
      expect(await s.value("select owner_employee_id from clients where id = $1", [C.Z])).toBe(U.E3.employeeId);
      const timeline = await s.rows<{ title: string; event_type: string }>(
        "select title, event_type from client_timeline_events where client_id = $1 and event_type = 'employee_assigned'",
        [C.A],
      );
      expect(timeline).toEqual([{ title: "Test E1's work moved to Test E3", event_type: "employee_assigned" }]);
      expect(await s.value<number>("select count(*)::int from activity_logs where entity_type = 'employee' and entity_id = $1 and action = 'work_reassigned'", [U.E1.employeeId])).toBe(1);
      // E1 now holds nothing open, so disabling works.
      await s.exec("update employees set is_active = false where id = $1", [U.E1.employeeId]);
    });
  });

  it("moves team places without doubling them", async () => {
    await db.asSuper(async (s) => {
      await s.exec("insert into client_team_members (client_id, employee_id, team_role) values ($1, $2, 'preparer')", [C.A, U.E3.employeeId]);
      await s.as(U.P1);
      const r = await s.value<Record<string, number>>("select reassign_all_work($1, $2)", [U.D.employeeId, U.E3.employeeId]);
      expect(r.team).toBe(1);
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from client_team_members where client_id = $1 and employee_id = $2", [C.A, U.E3.employeeId])).toBe(1);
      expect(await s.value<number>("select count(*)::int from client_team_members where employee_id = $1", [U.D.employeeId])).toBe(0);
    });
  });

  it("refuses: Employees, Managers moving a Manager's work, a disabled or the same person", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select reassign_all_work($1, $2)", [U.E1.employeeId, U.E3.employeeId]))).toMatch(/Only Partners and Managers/);
    });
    await db.asRole(U.M1, async (s) => {
      expect(userMessage(await s.fails("select reassign_all_work($1, $2)", [U.M2.employeeId, U.E3.employeeId]))).toMatch(/A Partner moves work for Managers/);
      expect(userMessage(await s.fails("select reassign_all_work($1, $2)", [U.E1.employeeId, U.D.employeeId]))).toMatch(/Test D's account is disabled/);
      expect(userMessage(await s.fails("select reassign_all_work($1, $1)", [U.E1.employeeId]))).toMatch(/already theirs/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// change_staff_email, revoke_auth_sessions, people_overview
// -------------------------------------------------------------------------------------------------

describe("change_staff_email (§4.5 point 4)", () => {
  it("moves the profile and the record together; refuses duplicates and Managers on Managers", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.value("select change_staff_email($1, 'e3.new@taxwise.test', $2::timestamptz)", [U.E3.employeeId, await employeeUpdatedAt(s, U.E3)]);
      expect(await s.value("select email::text from employees where id = $1", [U.E3.employeeId])).toBe("e3.new@taxwise.test");
      expect(await s.value("select email::text from profiles where id = $1", [U.E3.id])).toBe("e3.new@taxwise.test");
      expect(userMessage(await s.fails("select change_staff_email($1, 'E1@TaxWise.test', $2::timestamptz)", [U.E3.employeeId, await employeeUpdatedAt(s, U.E3)]))).toBe(
        "Someone already uses that email address.",
      );
      // a portal user's address counts too
      expect(userMessage(await s.fails("select change_staff_email($1, $3, $2::timestamptz)", [U.E3.employeeId, await employeeUpdatedAt(s, U.E3), U.CA.email]))).toMatch(/already uses/);
      expect(userMessage(await s.fails("select change_staff_email($1, 'm2.new@taxwise.test', $2::timestamptz)", [U.M2.employeeId, await employeeUpdatedAt(s, U.M2)]))).toMatch(/Only a Partner/);
    });
  });
});

describe("revoke_auth_sessions", () => {
  it("is for the service role only", async () => {
    await db.asSuper(async (s) => {
      expect(await s.value("select has_function_privilege('authenticated', 'public.revoke_auth_sessions(uuid)', 'execute')")).toBe(false);
      expect(await s.value("select has_function_privilege('service_role', 'public.revoke_auth_sessions(uuid)', 'execute')")).toBe(true);
      expect(await s.value<number>("select revoke_auth_sessions($1)", [U.E1.id])).toBe(0);
    });
    await db.asRole(U.P1, async (s) => {
      expect((await s.fails("select revoke_auth_sessions($1)", [U.E1.id])).code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });
});

describe("people_overview (§7.11.1)", () => {
  it("Partners and Managers see the team with login status and open work; others see only themselves", async () => {
    await db.asSuper(async (s) => {
      await s.exec("insert into employees (full_name, email, staff_role) values ('New Joiner', 'new.joiner@taxwise.test', 'employee')");
      await s.as(U.M1);
      const rows = await s.rows<{ full_name: string; login_status: string; open_tasks: number; role: string }>(
        "select full_name, login_status, open_tasks, role::text from people_overview order by full_name",
      );
      const by = new Map(rows.map((r) => [r.full_name, r]));
      expect(by.get("Test D")?.login_status).toBe("disabled");
      expect(by.get("New Joiner")?.login_status).toBe("no_login");
      expect(by.get("Test E1")).toMatchObject({ login_status: "active", open_tasks: 1, role: "employee" });
      expect(by.get("Test P1")?.role).toBe("partner");
      const cols = await s.rows<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'people_overview'");
      expect(cols.map((c) => c.column_name)).not.toContain("cost_rate_per_hour");
      expect(cols.map((c) => c.column_name)).not.toContain("billing_rate_per_hour");
      await s.as(U.E1);
      expect(await s.rows("select full_name from people_overview")).toEqual([{ full_name: "Test E1" }]);
      await s.as(U.CA);
      expect(await s.value<number>("select count(*)::int from people_overview")).toBe(0);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Profile images (§7.1)
// -------------------------------------------------------------------------------------------------

describe("profile-images bucket (§7.1)", () => {
  const avatar = (u: TestUser) => `${u.id}/avatar-${uuid()}.png`;
  const signature = (u: TestUser) => `${u.id}/signature-${uuid()}.png`;
  const put = (s: Session, name: string) => s.attempt("insert into storage.objects (bucket_id, name) values ('profile-images', $1)", [name]);

  it("owners write their own avatar; only Partners keep a signature; staff read avatars, not signatures", async () => {
    await db.asSuper(async (s) => {
      const e1Avatar = avatar(U.E1);
      const p1Signature = signature(U.P1);
      await s.as(U.E1);
      expect((await put(s, e1Avatar)).ok).toBe(true);
      expect((await put(s, avatar(U.E2))).ok).toBe(false);
      expect((await put(s, signature(U.E1))).ok).toBe(false);
      expect((await put(s, `${U.E1.id}/notes.txt`)).ok).toBe(false);
      await s.as(U.P1);
      expect((await put(s, p1Signature)).ok).toBe(true);
      await s.as(U.E2);
      expect(await s.value<number>("select count(*)::int from storage.objects where bucket_id = 'profile-images' and name = $1", [e1Avatar])).toBe(1);
      expect(await s.value<number>("select count(*)::int from storage.objects where bucket_id = 'profile-images' and name = $1", [p1Signature])).toBe(0);
      await s.as(U.P2);
      expect(await s.value<number>("select count(*)::int from storage.objects where bucket_id = 'profile-images' and name = $1", [p1Signature])).toBe(0);
      await s.as(U.CA);
      expect(await s.value<number>("select count(*)::int from storage.objects where bucket_id = 'profile-images'")).toBe(0);
    });
  });

  it("profiles point only at the owner's own well-formed files", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update profiles set avatar_path = $2 where id = $1", [U.E1.id, avatar(U.E1)])).toBe(1);
      expect(userMessage(await s.fails("update profiles set avatar_path = $2 where id = $1", [U.E1.id, avatar(U.E2)]))).toMatch(/Upload the photo again/);
      expect(userMessage(await s.fails("update profiles set signature_path = $2 where id = $1", [U.E1.id, signature(U.E1)]))).toMatch(/Only Partners/);
    });
    await db.asRole(U.P1, async (s) => {
      expect(await s.exec("update profiles set signature_path = $2 where id = $1", [U.P1.id, signature(U.P1)])).toBe(1);
    });
  });
});

describe("update_my_contact (§7.1 Profile)", () => {
  it("updates your own name and phone on the profile and the staff record; refuses if they changed since", async () => {
    await db.asRole(U.E1, async (s) => {
      const was = await s.one<{ full_name: string; phone: string | null }>("select full_name, phone from profiles where id = $1", [U.E1.id]);
      // A preferences write in between (theme, favourites) is not a conflict.
      await s.exec("update profiles set preferences = preferences || '{\"theme\":\"dark\"}'::jsonb where id = $1", [U.E1.id]);
      await s.value("select update_my_contact($1, $2, $3, $4)", ["Test E1 Renamed", "+91 98200 11111", was.full_name, was.phone ?? ""]);
      expect(await s.one("select full_name, phone from profiles where id = $1", [U.E1.id])).toEqual({ full_name: "Test E1 Renamed", phone: "+91 98200 11111" });
      expect(await s.one("select full_name, phone from employees where id = $1", [U.E1.employeeId])).toEqual({ full_name: "Test E1 Renamed", phone: "+91 98200 11111" });
      // Stale: the page still shows the old name.
      expect(userMessage(await s.fails("select update_my_contact($1, $2, $3, $4)", ["Test E1 Again", "", was.full_name, was.phone ?? ""]))).toMatch(
        /changed at .*after you opened this page/,
      );
      expect(userMessage(await s.fails("select update_my_contact($1, $2, $3, $4)", ["X", "", "Test E1 Renamed", "+91 98200 11111"]))).toBe("Enter your full name.");
      expect(userMessage(await s.fails("select update_my_contact($1, $2, $3, $4)", ["Test E1", "call me", "Test E1 Renamed", "+91 98200 11111"]))).toMatch(/digits only/);
    });
    await db.asRole(U.CA, async (s) => {
      expect(userMessage(await s.fails("select update_my_contact($1, $2, $3, $4)", ["Client Person", "", "", ""]))).toMatch(/Only the firm's staff/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Attendance corrections (§7.12)
// -------------------------------------------------------------------------------------------------

describe("attendance corrections (§7.12, §4.1)", () => {
  const correct = (s: Session, who: TestUser, by: TestUser | null, reason: string | null) =>
    s.attempt(
      `insert into attendance_records (employee_id, date, status, corrected_by, correction_reason)
       values ($1, today_ist() - 3, 'present', $2, $3)
       on conflict (employee_id, date) do update set status = excluded.status, corrected_by = excluded.corrected_by, correction_reason = excluded.correction_reason`,
      [who.employeeId, by?.id ?? null, reason],
    );

  it("need who and why; Managers correct Employees only; Employees can't", async () => {
    await db.asRole(U.M1, async (s) => {
      const noReason = await correct(s, U.E1, U.M1, null);
      expect(noReason.ok).toBe(false);
      expect(await correct(s, U.E1, U.P1, "Forgot to sign in")).toMatchObject({ ok: false });
      expect(await correct(s, U.E1, U.M1, "Worked at the client's office")).toMatchObject({ ok: true });
      const onManager = await correct(s, U.M2, U.M1, "Worked at the client's office");
      expect(onManager.ok ? "" : onManager.message).toMatch(/Managers correct Employees/);
    });
    await db.asRole(U.P1, async (s) => {
      expect(await correct(s, U.M2, U.P1, "Out at a hearing")).toMatchObject({ ok: true });
    });
    await db.asRole(U.E1, async (s) => {
      expect((await correct(s, U.E1, U.E1, "Me")).ok).toBe(false);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Leave: decisions and attendance (§7.11.3, §18.3 Employee 5)
// -------------------------------------------------------------------------------------------------

describe("leave decisions (§7.11.3)", () => {
  /** A Monday-to-Saturday week of working days well ahead: next Monday + 14 days, Mon–Tue. */
  const leaveSql = `insert into employee_leave (employee_id, start_date, end_date, half_day)
    values ($1, $2::date, $3::date, $4) returning id, updated_at::text as token`;

  async function newLeave(s: Session, who: TestUser, startOffset: number, endOffset: number, halfDay = false) {
    const start = await s.value<string>("select (date_trunc('week', today_ist() + 14) + ($1 || ' days')::interval)::date::text", [String(startOffset)]);
    const end = await s.value<string>("select (date_trunc('week', today_ist() + 14) + ($1 || ' days')::interval)::date::text", [String(endOffset)]);
    const row = await s.one<{ id: string; token: string }>(leaveSql, [who.employeeId, start, end, halfDay]);
    return { ...row, start, end };
  }

  it("approval marks the working days On leave; a correction already made stays", async () => {
    await db.asSuper(async (s) => {
      const leave = await newLeave(s, U.E1, 0, 2); // Mon–Wed
      await s.exec("delete from holidays");
      await s.exec(
        "insert into attendance_records (employee_id, date, status, corrected_by, correction_reason) values ($1, $2::date + 1, 'present', $3, 'Came in for the audit')",
        [U.E1.employeeId, leave.start, U.M1.id],
      );
      await s.as(U.M1);
      const r = await s.value<Record<string, unknown>>("select decide_leave($1, 'approved', 'Enjoy', $2::timestamptz)", [leave.id, leave.token]);
      expect(r.status).toBe("approved");
      await s.as("super");
      const days = await s.rows<{ date: string; status: string }>(
        "select date::text, status::text from attendance_records where employee_id = $1 and date between $2 and $3 order by date",
        [U.E1.employeeId, leave.start, leave.end],
      );
      expect(days.map((d) => d.status)).toEqual(["on_leave", "present", "on_leave"]);
      expect(await s.value("select decided_by from employee_leave where id = $1", [leave.id])).toBe(U.M1.id);
    });
  });

  it("skips holidays and non-working days; a half day is noted", async () => {
    await db.asSuper(async (s) => {
      const leave = await newLeave(s, U.E2, 5, 7, false); // Sat–Mon: Sunday is not a working day
      await s.exec("insert into holidays (date, name) values ($1::date + 2, 'Test holiday') on conflict do nothing", [leave.start]);
      await s.as(U.P1);
      await s.value("select decide_leave($1, 'approved', null, $2::timestamptz)", [leave.id, leave.token]);
      await s.as("super");
      const days = await s.rows<{ date: string }>("select date::text from attendance_records where employee_id = $1 and date between $2 and $3 order by date", [
        U.E2.employeeId,
        leave.start,
        leave.end,
      ]);
      expect(days.map((d) => d.date)).toEqual([leave.start]);
      const half = await newLeave(s, U.E2, 8, 8, true);
      await s.as(U.M1);
      await s.value("select decide_leave($1, 'approved', null, $2::timestamptz)", [half.id, half.token]);
      await s.as("super");
      expect(await s.value("select notes from attendance_records where employee_id = $1 and date = $2", [U.E2.employeeId, half.start])).toBe("Half-day leave");
    });
  });

  it("refuses: your own leave, a Manager on a Manager's, an Employee, a decided leave, a stale token", async () => {
    await db.asSuper(async (s) => {
      const own = await newLeave(s, U.M1, 0, 0);
      const manager = await newLeave(s, U.M2, 1, 1);
      const employee = await newLeave(s, U.E2, 2, 2);
      await s.as(U.M1);
      expect(userMessage(await s.fails("select decide_leave($1, 'approved', null, $2::timestamptz)", [own.id, own.token]))).toBe(
        "You can't decide your own leave. Another approver decides it.",
      );
      expect(userMessage(await s.fails("select decide_leave($1, 'approved', null, $2::timestamptz)", [manager.id, manager.token]))).toBe(
        "A Partner decides leave for Managers and Partners.",
      );
      expect(userMessage(await s.fails("select decide_leave($1, 'approved', null, '2020-01-01'::timestamptz)", [employee.id]))).toMatch(/Reload/);
      await s.value("select decide_leave($1, 'declined', 'Year-end closing', $2::timestamptz)", [employee.id, employee.token]);
      const fresh = await s.value<string>("select updated_at::text from employee_leave where id = $1", [employee.id]);
      expect(userMessage(await s.fails("select decide_leave($1, 'approved', null, $2::timestamptz)", [employee.id, fresh]))).toBe(
        "This leave is already declined, so it can't be decided again.",
      );
      await s.as(U.E1);
      expect(userMessage(await s.fails("select decide_leave($1, 'approved', null, $2::timestamptz)", [manager.id, manager.token]))).toMatch(
        /Only Managers and Partners/,
      );
    });
  });

  it("direct writes: nobody approves their own leave, a decided leave keeps its dates, new leave starts as a request", async () => {
    await db.asSuper(async (s) => {
      const own = await newLeave(s, U.P1, 0, 0);
      const other = await newLeave(s, U.E2, 3, 3);
      await s.as(U.P1);
      expect(userMessage(await s.fails("update employee_leave set status = 'approved' where id = $1", [own.id]))).toMatch(/your own leave/);
      // A direct approval still marks attendance and records who decided.
      expect(await s.exec("update employee_leave set status = 'approved' where id = $1", [other.id])).toBe(1);
      expect(await s.value("select decided_by from employee_leave where id = $1", [other.id])).toBe(U.P1.id);
      expect(await s.value("select status::text from attendance_records where employee_id = $1 and date = $2", [U.E2.employeeId, other.start])).toBe("on_leave");
      expect(userMessage(await s.fails("update employee_leave set end_date = end_date + 1 where id = $1", [other.id]))).toMatch(/Cancel it and ask again/);
      await s.as(U.M1);
      expect(
        userMessage(await s.fails("insert into employee_leave (employee_id, start_date, end_date, status) values ($1, today_ist() + 40, today_ist() + 40, 'approved')", [U.E1.employeeId])),
      ).toMatch(/starts as a request/);
    });
  });

  it("cancelling approved leave clears the days ahead; the requester can't once it has started", async () => {
    await db.asSuper(async (s) => {
      const leave = await newLeave(s, U.E1, 0, 1);
      await s.as(U.M1);
      await s.value("select decide_leave($1, 'approved', null, $2::timestamptz)", [leave.id, leave.token]);
      await s.as(U.E1);
      const token = await s.value<string>("select updated_at::text from employee_leave where id = $1", [leave.id]);
      const r = await s.value<Record<string, unknown>>("select cancel_leave($1, $2::timestamptz)", [leave.id, token]);
      expect(r).toMatchObject({ status: "cancelled", was: "approved", days_cleared: 2 });
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from attendance_records where employee_id = $1 and date between $2 and $3", [U.E1.employeeId, leave.start, leave.end])).toBe(0);

      const started = await s.one<{ id: string }>(
        "insert into employee_leave (employee_id, start_date, end_date, status, decided_by, decided_at) values ($1, today_ist(), today_ist() + 1, 'approved', $2, now()) returning id",
        [U.E1.employeeId, U.M1.id],
      );
      await s.as(U.E1);
      const t2 = await s.value<string>("select updated_at::text from employee_leave where id = $1", [started.id]);
      expect(userMessage(await s.fails("select cancel_leave($1, $2::timestamptz)", [started.id, t2]))).toBe("This leave has already started. Ask a Manager to correct it.");
      await s.as(U.E2);
      expect(userMessage(await s.fails("select cancel_leave($1, $2::timestamptz)", [started.id, t2]))).toMatch(/only your own leave/);
      await s.as(U.M1);
      await s.value("select cancel_leave($1, $2::timestamptz)", [started.id, t2]);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Presence (§7.12)
// -------------------------------------------------------------------------------------------------

describe("presence sessions (§7.12)", () => {
  it("one open session per person", async () => {
    await db.asSuper(async (s) => {
      const e = await s.fails("insert into employee_sessions (employee_id, user_id) values ($1, $2)", [U.E1.employeeId, U.E1.id]);
      expect(e.code).toBe(SQLSTATE.uniqueViolation);
      await s.exec("update employee_sessions set is_active = false, logout_at = last_active_at where employee_id = $1", [U.E1.employeeId]);
      expect(await s.exec("insert into employee_sessions (employee_id, user_id) values ($1, $2)", [U.E1.employeeId, U.E1.id])).toBe(1);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Cover merging (§4.7 limits)
// -------------------------------------------------------------------------------------------------

describe("cover merge on insert (§4.7)", () => {
  const grant = (
    s: Session,
    o: { client?: string; cover?: TestUser; from: string; to: string; by?: TestUser; vault?: boolean; handover?: string | null; kind?: "client" | "person"; absent?: TestUser },
  ) =>
    s.one<{ id: string; starts_at: string; ends_at: string; include_vault: boolean; handover_note: string | null }>(
      `insert into client_covers (kind, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, reason, granted_by, include_vault, handover_note)
       values ($1::cover_kind, $2, $3, $4, now() + $5::interval, now() + $6::interval, 'leave', $7, $8, $9)
       returning id, starts_at::text, ends_at::text, include_vault, handover_note`,
      [
        o.kind ?? "client",
        (o.kind ?? "client") === "client" ? (o.client ?? C.B) : null,
        o.absent?.employeeId ?? null,
        (o.cover ?? U.E3).employeeId,
        o.from,
        o.to,
        (o.by ?? U.P1).id,
        o.vault ?? false,
        o.handover ?? null,
      ],
    );

  it("overlapping covers for the same client and cover person merge; the later end wins", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.P1);
      const first = await grant(s, { from: "0 minutes", to: "2 days", vault: true, handover: "Call Mr Rao about the GST notice" });
      await s.as(U.M1);
      const second = await grant(s, { from: "1 day", to: "4 days", by: U.M1 });
      expect(second.include_vault).toBe(true);
      expect(second.handover_note).toBe("Call Mr Rao about the GST notice");
      await s.as("super");
      const merged = await s.one<{ starts: boolean; ends: boolean }>(
        "select starts_at = (select starts_at from client_covers where id = $2) as starts, ends_at > now() + interval '3 days' as ends from client_covers where id = $1",
        [second.id, first.id],
      );
      expect(merged).toEqual({ starts: true, ends: true });
      const old = await s.one<{ revoke_reason: string; merged_into: string }>("select revoke_reason, merged_into from client_covers where id = $1", [first.id]);
      expect(old).toEqual({ revoke_reason: "Merged into a longer cover", merged_into: second.id });
    });
  });

  it("bridges two covers; leaves other people's and non-overlapping covers alone; refuses past 90 days", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.P1);
      const a = await grant(s, { from: "0 minutes", to: "1 day" });
      const b = await grant(s, { from: "2 days", to: "3 days" });
      const other = await grant(s, { from: "0 minutes", to: "3 days", cover: U.E1 });
      const bridge = await grant(s, { from: "12 hours", to: "50 hours" });
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from client_covers where id = any($1::uuid[]) and merged_into = $2", [[a.id, b.id], bridge.id])).toBe(2);
      expect(await s.value("select revoked_at from client_covers where id = $1", [other.id])).toBeNull();
      await s.as(U.P1);
      const lone = await grant(s, { from: "10 days", to: "11 days" });
      await s.as("super");
      expect(await s.value("select revoked_at from client_covers where id = $1", [lone.id])).toBeNull();
      await s.as(U.P1);
      await grant(s, { from: "0 minutes", to: "60 days", cover: U.E4, client: C.A });
      expect(userMessage(await s.fails(
        `insert into client_covers (kind, client_id, cover_employee_id, starts_at, ends_at, reason, granted_by)
         values ('client', $1, $2, now() + interval '50 days', now() + interval '100 days', 'leave', $3)`,
        [C.A, U.E4.employeeId, U.P1.id],
      ))).toMatch(/run past 90 days/);
    });
  });

  it("person covers merge by absent person; a Manager still can't add portal passwords", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.M1);
      const p1 = await grant(s, { kind: "person", absent: U.E4, from: "0 minutes", to: "1 day", by: U.M1 });
      const p2 = await grant(s, { kind: "person", absent: U.E4, from: "20 hours", to: "2 days", by: U.M1 });
      await s.as("super");
      expect(await s.value("select merged_into from client_covers where id = $1", [p1.id])).toBe(p2.id);
      await s.as(U.M1);
      expect(userMessage(await s.fails(
        `insert into client_covers (kind, client_id, cover_employee_id, ends_at, reason, granted_by, include_vault)
         values ('client', $1, $2, now() + interval '1 day', 'leave', $3, true)`,
        [C.B, U.E3.employeeId, U.M1.id],
      ))).toMatch(/Only a Partner can include portal passwords/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Absent today without cover (§7.2, §4.7): what lib/data/covers.ts getAbsentWithoutCover reads
// under the viewer's session
// -------------------------------------------------------------------------------------------------

describe("absent today without cover: the reads behind the Manager's list (§7.2)", () => {
  it("a Manager reads everyone's leave, today's sessions and the covers in force; an Employee only their own", async () => {
    await db.asSuper(async (s) => {
      await s.exec(
        `insert into employee_leave (employee_id, start_date, end_date, type, status, decided_by, decided_at)
         values ($1, today_ist(), today_ist() + 2, 'annual', 'approved', $2, now())`,
        [U.E2.employeeId, U.M1.id],
      );
      await s.exec("update employee_sessions set is_active = false, logout_at = last_active_at where employee_id = $1", [U.E1.employeeId]);
      await s.exec("insert into employee_sessions (employee_id, user_id, login_at, last_active_at) values ($1, $2, now(), now())", [U.E1.employeeId, U.E1.id]);
      await s.exec(
        `insert into client_covers (kind, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, reason, granted_by)
         values ('client', $1, $2, $3, now() - interval '1 hour', now() + interval '1 day', 'leave', $4)`,
        [C.B, U.E2.employeeId, U.E4.employeeId, U.M1.id],
      );

      await s.as(U.M1);
      const leave = await s.rows<{ employee_id: string }>("select employee_id from employee_leave where status = 'approved' and today_ist() between start_date and end_date");
      expect(leave.map((l) => l.employee_id)).toContain(U.E2.employeeId);
      const sessions = await s.rows<{ employee_id: string }>("select employee_id from employee_sessions where last_active_at >= now() - interval '1 day'");
      expect(sessions.map((r) => r.employee_id)).toContain(U.E1.employeeId);
      const covers = await s.rows<{ client_id: string }>("select client_id from covers_in_force");
      expect(covers.map((c) => c.client_id)).toContain(C.B);
      const people = await s.rows<{ id: string }>("select id from people_overview where login_status = 'active'");
      expect(people.map((p) => p.id)).toEqual(expect.arrayContaining([U.E1.employeeId, U.E2.employeeId, U.M2.employeeId]));

      await s.as(U.E3);
      expect(await s.rows("select 1 from employee_sessions where employee_id <> $1", [U.E3.employeeId])).toEqual([]);
      expect(await s.rows("select 1 from employee_leave where employee_id <> $1", [U.E3.employeeId])).toEqual([]);
      expect(await s.rows("select 1 from covers_in_force")).toEqual([]);
      expect((await s.rows<{ id: string }>("select id from people_overview")).map((p) => p.id)).toEqual([U.E3.employeeId]);
    });
  });
});
