import { describe, expect, it } from "vitest";
import {
  AddPersonSchema,
  ChangeRoleSchema,
  IMPORT_COLUMNS,
  ImportPeopleSchema,
  IMPORT_MAX_ROWS,
  IssueLoginsSchema,
  ISSUE_LOGINS_MAX,
  LOGIN_STATUS,
  ROLE_SCOPE,
  ReassignWorkSchema,
  UpdatePersonSchema,
  assignableRoles,
  canManagePerson,
  capacityWindow,
  checkImportRows,
  daysLate,
  deviceLabel,
  isStaffRole,
  loginInviteEmail,
  loginShareMessage,
  manageRefusal,
  missingImportColumns,
  normaliseImportHeader,
  phoneProblem,
  summarisePerformance,
  targetMinutesFor,
} from "@/lib/schemas/people";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("who may manage whom (§4.1, §4.5)", () => {
  it("Partners give any staff role; Managers only Employee; nobody else any", () => {
    expect(assignableRoles("partner")).toEqual(["partner", "manager", "employee"]);
    expect(assignableRoles("manager")).toEqual(["employee"]);
    expect(assignableRoles("employee")).toEqual([]);
    expect(assignableRoles("client")).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
  });

  it("Partners manage Partners, Managers and Employees; Managers can't touch Partners or Managers", () => {
    for (const s of ["partner", "manager", "employee"] as const) expect(canManagePerson("partner", s)).toBe(true);
    expect(canManagePerson("partner", "client")).toBe(false);
    expect(canManagePerson("manager", "employee")).toBe(true);
    expect(canManagePerson("manager", "manager")).toBe(false);
    expect(canManagePerson("manager", "partner")).toBe(false);
    expect(canManagePerson("employee", "employee")).toBe(false);
    expect(canManagePerson("client", "employee")).toBe(false);
    expect(canManagePerson(undefined, "employee")).toBe(false);
  });

  it("explains the refusal in the voice of §4.1", () => {
    expect(manageRefusal("manager")).toBe("Only a Partner can change a Manager or a Partner.");
    expect(manageRefusal("employee")).toBe("Only Partners and Managers manage the team.");
  });

  it("the role picker says what each role grants and where it stops", () => {
    for (const r of ["partner", "manager", "employee"] as const) {
      expect(ROLE_SCOPE[r].grants.length).toBeGreaterThan(10);
      expect(ROLE_SCOPE[r].stops.length).toBeGreaterThan(10);
    }
    expect(ROLE_SCOPE.employee.stops).toMatch(/fees/);
    expect(isStaffRole("manager")).toBe(true);
    expect(isStaffRole("client")).toBe(false);
  });

  it("every login status explains itself", () => {
    expect(Object.keys(LOGIN_STATUS).sort()).toEqual(["active", "disabled", "no_login"]);
    expect(LOGIN_STATUS.no_login.meaning).toMatch(/Issue login/);
  });
});

describe("phoneProblem", () => {
  it("accepts numbers as people type them", () => {
    expect(phoneProblem("98765 43210")).toBeNull();
    expect(phoneProblem("+91 98765-43210")).toBeNull();
    expect(phoneProblem("(080) 2345 6789")).toBeNull();
  });
  it("refuses letters and lengths outside 7–15 digits", () => {
    expect(phoneProblem("98765abc")).toMatch(/digits only/);
    expect(phoneProblem("12345")).toMatch(/full number/);
    expect(phoneProblem("1234567890123456")).toMatch(/full number/);
  });
});

describe("AddPersonSchema (§4.5 point 1)", () => {
  const base = { full_name: "Ravi Kumar", email: "Ravi.Kumar@twchartered.com", role: "employee" as const };

  it("normalises the email, blanks to null, rates to decimal strings", () => {
    const r = AddPersonSchema.safeParse({ ...base, phone: "", department: "  ", billing_rate_per_hour: "1,250.5", cost_rate_per_hour: "" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.email).toBe("ravi.kumar@twchartered.com");
    expect(r.data.phone).toBeNull();
    expect(r.data.department).toBeNull();
    expect(r.data.billing_rate_per_hour).toBe("1250.50");
    expect(r.data.cost_rate_per_hour).toBeNull();
    expect(r.data.vault_access).toBe(false);
  });

  it("needs a name, an email and a role", () => {
    const r = AddPersonSchema.safeParse({ full_name: "R", email: "nope", role: "boss" });
    expect(r.success).toBe(false);
    if (r.success) return;
    const paths = r.error.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["full_name", "email", "role"]));
  });

  it("an ICAI membership number is six digits, kept with leading zeros, for Partners only", () => {
    const ok = AddPersonSchema.safeParse({ ...base, role: "partner", icai_membership_no: "12345" });
    expect(ok.success && ok.data.icai_membership_no).toBe("012345");
    const bad = AddPersonSchema.safeParse({ ...base, role: "partner", icai_membership_no: "1234567" });
    expect(bad.success).toBe(false);
    const notPartner = AddPersonSchema.safeParse({ ...base, role: "manager", icai_membership_no: "123456" });
    expect(notPartner.success).toBe(false);
    if (!notPartner.success) expect(notPartner.error.issues[0].path).toEqual(["icai_membership_no"]);
  });

  it("refuses a WhatsApp number that can't be a mobile and a rate that isn't money", () => {
    const r = AddPersonSchema.safeParse({ ...base, whatsapp: "12", billing_rate_per_hour: "abc" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["whatsapp", "billing_rate_per_hour"]));
  });
});

describe("the lifecycle schemas carry the concurrency token (§13)", () => {
  it("edits, role changes refuse without updated_at", () => {
    expect(UpdatePersonSchema.safeParse({ id: A, full_name: "Ravi Kumar", updated_at: "" }).success).toBe(false);
    expect(ChangeRoleSchema.safeParse({ id: A, role: "manager", updated_at: "2026-10-22T10:00:00Z" }).success).toBe(true);
  });
  it("work can't be reassigned to the same person", () => {
    const r = ReassignWorkSchema.safeParse({ from_employee_id: A, to_employee_id: A });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["to_employee_id"]);
    expect(ReassignWorkSchema.safeParse({ from_employee_id: A, to_employee_id: B }).success).toBe(true);
  });
  it("issues at most 50 logins at a time", () => {
    expect(IssueLoginsSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(IssueLoginsSchema.safeParse({ ids: Array.from({ length: ISSUE_LOGINS_MAX + 1 }, () => A) }).success).toBe(false);
    expect(IssueLoginsSchema.safeParse({ ids: [A, B] }).success).toBe(true);
  });
});

describe("bulk import (§4.5 point 8)", () => {
  it("reads headers whatever their case or spacing", () => {
    expect(normaliseImportHeader("Name")).toBe("name");
    expect(normaliseImportHeader(" Date of joining ")).toBe("date_of_joining");
    expect(normaliseImportHeader("date-of-joining")).toBe("date_of_joining");
    expect(normaliseImportHeader("Full name")).toBe("name");
    expect(normaliseImportHeader("Mobile")).toBe("phone");
    expect(normaliseImportHeader("salary")).toBeNull();
    expect(IMPORT_COLUMNS).toEqual(["name", "email", "phone", "department", "designation", "role", "date_of_joining"]);
  });

  it("name and email columns are required", () => {
    expect(missingImportColumns(["Name", "Email", "Role"])).toEqual([]);
    expect(missingImportColumns(["Name", "Phone"])).toEqual(["email"]);
    expect(missingImportColumns([])).toEqual(["name", "email"]);
  });

  it("reports every problem per row, numbered as in the file", () => {
    const rows = checkImportRows(
      [
        { name: "Ravi Kumar", email: "RAVI@twchartered.com", phone: "98765 43210", role: "", date_of_joining: "01/06/2026", department: "GST" },
        { name: "", email: "bad", role: "boss", date_of_joining: "someday" },
        { name: "Anita Rao", email: "ravi@twchartered.com", role: "Manager" },
        { name: "Old Hand", email: "old@twchartered.com", role: "staff" },
      ],
      { actorRole: "partner", existingEmails: new Set(["old@twchartered.com"]) },
    );
    expect(rows.map((r) => r.line)).toEqual([2, 3, 4, 5]);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].row).toEqual({
      full_name: "Ravi Kumar",
      email: "ravi@twchartered.com",
      phone: "98765 43210",
      department: "GST",
      designation: null,
      role: "employee",
      date_of_joining: "2026-06-01",
    });
    expect(rows[1].row).toBeNull();
    expect(rows[1].errors).toEqual([
      "Name is missing.",
      "\"bad\" isn't a valid email address.",
      "Role \"boss\" isn't one of Partner, Manager or Employee.",
      "Date of joining \"someday\" isn't a date. Use 22/10/2026 or 2026-10-22.",
    ]);
    expect(rows[2].errors).toEqual(["ravi@twchartered.com is also on line 2."]);
    expect(rows[3].errors).toEqual(["old@twchartered.com is already on the team."]);
  });

  it("a Manager imports Employees only", () => {
    const [mgr, emp] = checkImportRows(
      [
        { name: "Anita Rao", email: "anita@twchartered.com", role: "manager" },
        { name: "Suresh M", email: "suresh@twchartered.com", role: "employee" },
      ],
      { actorRole: "manager" },
    );
    expect(mgr.errors).toEqual(["Managers import Employees only."]);
    expect(emp.row?.role).toBe("employee");
  });

  it("refuses an empty file and more than the row limit", () => {
    expect(ImportPeopleSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(ImportPeopleSchema.safeParse({ rows: Array.from({ length: IMPORT_MAX_ROWS + 1 }, () => ({ name: "x" })) }).success).toBe(false);
  });
});

describe("Login created (§4.5 point 2, §10 item 1)", () => {
  const share = { fullName: "Ravi Kumar", email: "ravi@twchartered.com", temporaryPassword: "Tw!x9Kp2qL", loginUrl: "https://app.twchartered.com/login", firmName: "TaxWise Consultants" };

  it("the WhatsApp draft has the login link, email and temporary password", () => {
    const m = loginShareMessage(share);
    expect(m).toContain("Hi Ravi, your TaxWise Consultants login is ready.");
    expect(m).toContain("Sign in: https://app.twchartered.com/login");
    expect(m).toContain("Email: ravi@twchartered.com");
    expect(m).toContain("Temporary password: Tw!x9Kp2qL");
    expect(m).toContain("set your own password");
  });

  it("the invite email names the firm in the subject and says they set their own password", () => {
    const invite = loginInviteEmail(share, "invite");
    expect(invite.subject).toBe("TaxWise Consultants | Your login to the practice app");
    expect(invite.text).toContain("A login has been created for you");
    expect(invite.text).toContain("Temporary password: Tw!x9Kp2qL");
    expect(invite.text).toContain("You'll set your own password when you first sign in.");
    const reset = loginInviteEmail(share, "reset");
    expect(reset.subject).toBe("TaxWise Consultants | Your password has been reset");
    expect(reset.text).toContain("has been reset");
  });
});

describe("capacity window (§7.11.4)", () => {
  it("is today and the next 13 days", () => {
    expect(capacityWindow("2026-10-23")).toEqual({ from: "2026-10-23", to: "2026-11-05" });
    expect(capacityWindow("2026-03-25", 7)).toEqual({ from: "2026-03-25", to: "2026-03-31" });
  });
});

describe("deviceLabel (active sessions, §7.1)", () => {
  it("names the browser and the system", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0")).toBe("Edge on Windows");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Mac");
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel("curl/8.0")).toBe("Unknown device");
  });
});

describe("performance (§7.11.2)", () => {
  it("daysLate counts whole IST days", () => {
    expect(daysLate("2026-10-20", "2026-10-20T17:00:00Z")).toBe(0); // 22:30 IST, same day
    expect(daysLate("2026-10-20", "2026-10-20T19:00:00Z")).toBe(1); // 00:30 IST next day
    expect(daysLate("2026-10-20", "2026-10-18T05:00:00Z")).toBe(-2);
  });

  it("on-time %, average days late and send-back rate", () => {
    const f = summarisePerformance(
      [
        { due_date: "2026-10-20", completion_date: "2026-10-20T06:00:00Z" },
        { due_date: "2026-10-20", completion_date: "2026-10-23T06:00:00Z" },
        { due_date: "2026-10-11", completion_date: "2026-10-12T06:00:00Z" },
        { due_date: null, completion_date: "2026-10-12T06:00:00Z" },
      ],
      [
        { from_status: "in_progress", to_status: "under_review" },
        { from_status: "under_review", to_status: "in_progress" },
        { from_status: "in_progress", to_status: "under_review" },
        { from_status: "under_review", to_status: "filed_done" },
        { from_status: "data_awaited", to_status: "under_review" },
      ],
    );
    expect(f).toEqual({
      filed: 4,
      filedOnTime: 2,
      filedLate: 2,
      averageDaysLate: 2,
      onTimePercent: 50,
      submittedForReview: 3,
      sentBack: 1,
      sendBackPercent: 33.3,
    });
  });

  it("nothing filed or reviewed gives no percentages, not zeros", () => {
    expect(summarisePerformance([], [])).toEqual({
      filed: 0,
      filedOnTime: 0,
      filedLate: 0,
      averageDaysLate: null,
      onTimePercent: null,
      submittedForReview: 0,
      sentBack: 0,
      sendBackPercent: null,
    });
  });

  it("spreads the weekly hours target over a span of days", () => {
    expect(targetMinutesFor(48, 7)).toBe(2880);
    expect(targetMinutesFor(48, 30)).toBe(12343);
    expect(targetMinutesFor(48, -3)).toBe(0);
  });
});
