/**
 * People: staff lifecycle forms and rules (§4.1, §4.5, §7.11). Zod schemas shared by the forms and
 * the server actions, plus the pure helpers both sides use (who may manage whom, the role picker's
 * wording, the CSV import check, the "Login created" message and the capacity window).
 * Client-safe: no server code here.
 */

import { z } from "zod";
import type { AppRole } from "@/lib/auth/roles";
import { emailField } from "@/lib/schemas/auth";
import { addDays, isDateString, type DateString } from "@/lib/domain/fy";
import { parseAmount, paiseToDecimalString } from "@/lib/domain/money";
import { normaliseMembershipNo } from "@/lib/domain/india-validators";
import { normalizeWhatsAppNumber } from "@/lib/domain/messaging";
import { parseDateInput } from "@/components/app/form/format";

// -------------------------------------------------------------------------------------------------
// Roles: who may manage whom (§4.1, §4.5)
// -------------------------------------------------------------------------------------------------

export const STAFF_ROLE_VALUES = ["partner", "manager", "employee"] as const;
export type StaffRole = (typeof STAFF_ROLE_VALUES)[number];

export function isStaffRole(v: unknown): v is StaffRole {
  return typeof v === "string" && (STAFF_ROLE_VALUES as readonly string[]).includes(v);
}

/** The roles an actor may give someone (§4.5 point 1: "A Manager can only create Employees"). */
export function assignableRoles(actor: AppRole | null | undefined): StaffRole[] {
  if (actor === "partner") return ["partner", "manager", "employee"];
  if (actor === "manager") return ["employee"];
  return [];
}

/**
 * Whether an actor may add, edit, disable or reset a person of `subject` role (§4.1: Partners
 * manage Partners and Managers; Managers manage Employees only).
 */
export function canManagePerson(actor: AppRole | null | undefined, subject: AppRole | null | undefined): boolean {
  if (actor === "partner") return subject === "partner" || subject === "manager" || subject === "employee";
  if (actor === "manager") return subject === "employee";
  return false;
}

/** The refusal when canManagePerson is false, in the voice of §4.1. */
export function manageRefusal(actor: AppRole | null | undefined): string {
  if (actor === "manager") return "Only a Partner can change a Manager or a Partner.";
  return "Only Partners and Managers manage the team.";
}

/** What each role grants and where it stops, for the role picker (§4.5 point 1). */
export const ROLE_SCOPE: Record<StaffRole, { label: string; grants: string; stops: string }> = {
  partner: {
    label: "Partner",
    grants: "Everything: firm settings, money, approvals, people and the audit log.",
    stops: "Nothing is held back. Partners must use two-step sign-in.",
  },
  manager: {
    label: "Manager",
    grants: "Every client, task, quotation and invoice; adds and manages Employees; approves Employees' leave.",
    stops: "Not firm settings, payments or the audit log, not other Managers or Partners, and not invoices above the approval limit.",
  },
  employee: {
    label: "Employee",
    grants: "The clients they own, are on the team of, or are covering; their tasks, timesheet and leave.",
    stops: "Never sees fees, invoices, receipts, quotations or leads, and can't set a task to Filed / Done.",
  },
};

// -------------------------------------------------------------------------------------------------
// Field building blocks
// -------------------------------------------------------------------------------------------------

/** The loaded row's updated_at (§13). */
export const concurrencyToken = z.string({ error: "Reload the page and try again." }).min(1, { error: "Reload the page and try again." });

const idField = z.uuid({ error: "Reload the page and try again." });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Use ${max} characters or fewer.` })
    .nullish()
    .transform((v) => (v ? v : null));

const nameField = z
  .string({ error: "Enter the person's name." })
  .trim()
  .min(2, { error: "Enter the person's full name." })
  .max(120, { error: "Use 120 characters or fewer." });

/** A phone number as people type it: digits with spaces, +, -, ( ). 7–15 digits. */
export function phoneProblem(value: string): string | null {
  if (!/^[0-9+\-\s()]+$/.test(value)) return "Use digits only, with spaces or a + if you like.";
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "Enter the full number, with the area code for a landline.";
  return null;
}

const phoneField = z
  .string()
  .trim()
  .max(30, { error: "That number is too long." })
  .nullish()
  .transform((v) => (v ? v : null))
  .superRefine((v, ctx) => {
    if (!v) return;
    const p = phoneProblem(v);
    if (p) ctx.addIssue({ code: "custom", message: p });
  });

const whatsappField = z
  .string()
  .trim()
  .max(30, { error: "That number is too long." })
  .nullish()
  .transform((v) => (v ? v : null))
  .superRefine((v, ctx) => {
    if (v && !normalizeWhatsAppNumber(v)) ctx.addIssue({ code: "custom", message: "Enter a mobile number that has WhatsApp, like 98765 43210." });
  });

const dateOfJoiningField = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isDateString(v), { error: "Enter the date, like 22 Oct 2026." });

/** An hourly rate in rupees, optional ("not billed hourly" when blank). Out: a decimal string or null. */
const rateField = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v, ctx) => {
    if (v === null || v === undefined) return null;
    const text = typeof v === "number" ? String(v) : v.trim();
    if (text === "") return null;
    const parsed = parseAmount(text);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error });
      return z.NEVER;
    }
    if (parsed.paise > 99_999_999) {
      ctx.addIssue({ code: "custom", message: "That rate is too high. Enter the rate per hour." });
      return z.NEVER;
    }
    return paiseToDecimalString(parsed.paise);
  });

/** ICAI membership number: six digits (leading zeros kept). Out: the normalised number or null. */
const membershipField = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    const n = normaliseMembershipNo(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "An ICAI membership number has 6 digits." });
      return z.NEVER;
    }
    return n;
  });

const roleField = z.enum(STAFF_ROLE_VALUES, { error: "Choose the person's role." });

// -------------------------------------------------------------------------------------------------
// Add, edit and the lifecycle actions (§4.5)
// -------------------------------------------------------------------------------------------------

/** §4.5 point 1. Partner-only fields are checked again by the server against the actor's role. */
export const AddPersonSchema = z
  .object({
    full_name: nameField,
    email: emailField,
    phone: phoneField,
    whatsapp: whatsappField,
    department: optionalText(80),
    designation: optionalText(80),
    date_of_joining: dateOfJoiningField,
    role: roleField,
    billing_rate_per_hour: rateField,
    cost_rate_per_hour: rateField,
    vault_access: z.boolean().default(false),
    icai_membership_no: membershipField,
  })
  .superRefine((d, ctx) => {
    if (d.icai_membership_no && d.role !== "partner") {
      ctx.addIssue({ code: "custom", path: ["icai_membership_no"], message: "Only Partners have an ICAI membership number here." });
    }
  });
export type AddPersonInput = z.input<typeof AddPersonSchema>;
export type AddPersonValues = z.output<typeof AddPersonSchema>;

/** Editing a person's details (§4.5, §7.11.2 Profile). Email and role have their own actions. */
export const UpdatePersonSchema = z.object({
  id: idField,
  updated_at: concurrencyToken,
  full_name: nameField,
  phone: phoneField,
  whatsapp: whatsappField,
  department: optionalText(80),
  designation: optionalText(80),
  date_of_joining: dateOfJoiningField,
  billing_rate_per_hour: rateField,
  /** Partner only (§5.2); ignored for anyone else. */
  cost_rate_per_hour: rateField,
  /** Partner only (§4.5); ignored for anyone else. */
  vault_access: z.boolean().optional(),
  /** Partners only, for a Partner's record. */
  icai_membership_no: membershipField,
});
export type UpdatePersonInput = z.input<typeof UpdatePersonSchema>;

export const PersonRefSchema = z.object({ id: idField });
export type PersonRefInput = z.input<typeof PersonRefSchema>;

export const ChangeEmailSchema = z.object({ id: idField, email: emailField, updated_at: concurrencyToken });
export type ChangeEmailInput = z.input<typeof ChangeEmailSchema>;

export const ChangeRoleSchema = z.object({ id: idField, role: roleField, updated_at: concurrencyToken });
export type ChangeRoleInput = z.input<typeof ChangeRoleSchema>;

export const SetActiveSchema = z.object({ id: idField, active: z.boolean(), updated_at: concurrencyToken });
export type SetActiveInput = z.input<typeof SetActiveSchema>;

export const DeletePersonSchema = z.object({ id: idField, updated_at: concurrencyToken });
export type DeletePersonInput = z.input<typeof DeletePersonSchema>;

export const ReassignWorkSchema = z
  .object({
    from_employee_id: idField,
    to_employee_id: z.uuid({ error: "Choose who takes the work." }),
  })
  .refine((d) => d.from_employee_id !== d.to_employee_id, { path: ["to_employee_id"], error: "Choose someone else: the work is already theirs." });
export type ReassignWorkInput = z.input<typeof ReassignWorkSchema>;

export const ISSUE_LOGINS_MAX = 50;
export const IssueLoginsSchema = z.object({
  ids: z
    .array(idField)
    .min(1, { error: "Choose who gets a login." })
    .max(ISSUE_LOGINS_MAX, { error: `Issue at most ${ISSUE_LOGINS_MAX} logins at a time.` }),
});
export type IssueLoginsInput = z.input<typeof IssueLoginsSchema>;

// -------------------------------------------------------------------------------------------------
// Bulk import (§4.5 point 8): name, email, phone, department, designation, role, date_of_joining
// -------------------------------------------------------------------------------------------------

export const IMPORT_COLUMNS = ["name", "email", "phone", "department", "designation", "role", "date_of_joining"] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
export const IMPORT_MAX_ROWS = 200;

/** A row as read from the CSV (every cell text). */
export type RawImportRow = Partial<Record<ImportColumn, string>>;

/** A row ready to import. */
export type ImportRow = {
  full_name: string;
  email: string;
  phone: string | null;
  department: string | null;
  designation: string | null;
  role: StaffRole;
  date_of_joining: DateString | null;
};

export type ImportRowCheck = { line: number; raw: RawImportRow; row: ImportRow | null; errors: string[] };

/** Header cells to column names: case, spaces and underscores don't matter ("Date of joining"). */
export function normaliseImportHeader(header: string): ImportColumn | null {
  const key = header.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((IMPORT_COLUMNS as readonly string[]).includes(key)) return key as ImportColumn;
  if (key === "full_name") return "name";
  if (key === "doj" || key === "joining_date" || key === "date_joined") return "date_of_joining";
  if (key === "mobile") return "phone";
  return null;
}

/** The required columns missing from a header row ("name" and "email" are required). */
export function missingImportColumns(headers: readonly string[]): ImportColumn[] {
  const have = new Set(headers.map(normaliseImportHeader).filter((h): h is ImportColumn => h !== null));
  return (["name", "email"] as const).filter((c) => !have.has(c));
}

const ROLE_WORDS: Record<string, StaffRole> = { partner: "partner", manager: "manager", employee: "employee", staff: "employee", article: "employee" };

/**
 * Checks every row of an import (§4.5 point 8, the per-row validation report): a name; a valid
 * email that isn't already in use or repeated in the file; a phone in shape; a role the importer
 * may give (blank = Employee; a Manager imports Employees only); a date of joining in any usual
 * form. Lines are numbered as in the file (the header is line 1).
 */
export function checkImportRows(
  rows: readonly RawImportRow[],
  opts: { actorRole: AppRole | null | undefined; existingEmails?: ReadonlySet<string> },
): ImportRowCheck[] {
  const allowed = new Set(assignableRoles(opts.actorRole));
  const seen = new Map<string, number>();
  return rows.map((raw, i) => {
    const line = i + 2;
    const errors: string[] = [];
    const name = (raw.name ?? "").trim().replace(/\s+/g, " ");
    if (name.length < 2) errors.push("Name is missing.");
    else if (name.length > 120) errors.push("Name is longer than 120 characters.");

    const emailRaw = (raw.email ?? "").trim().toLowerCase();
    const email = emailField.safeParse(emailRaw);
    if (!emailRaw) errors.push("Email is missing.");
    else if (!email.success) errors.push(`"${emailRaw}" isn't a valid email address.`);
    else if (opts.existingEmails?.has(email.data)) errors.push(`${email.data} is already on the team.`);
    else if (seen.has(email.data)) errors.push(`${email.data} is also on line ${seen.get(email.data)}.`);
    if (email.success && !seen.has(email.data)) seen.set(email.data, line);

    const phone = (raw.phone ?? "").trim() || null;
    if (phone) {
      const p = phoneProblem(phone);
      if (p) errors.push(`Phone: ${p}`);
    }

    const roleText = (raw.role ?? "").trim().toLowerCase();
    const role: StaffRole | undefined = roleText === "" ? "employee" : ROLE_WORDS[roleText];
    if (!role) errors.push(`Role "${raw.role}" isn't one of Partner, Manager or Employee.`);
    else if (!allowed.has(role)) errors.push(opts.actorRole === "manager" ? "Managers import Employees only." : "You can't add people.");

    const dojText = (raw.date_of_joining ?? "").trim();
    const doj = dojText ? parseDateInput(dojText) : null;
    if (dojText && !doj) errors.push(`Date of joining "${dojText}" isn't a date. Use 22/10/2026 or 2026-10-22.`);

    const department = (raw.department ?? "").trim() || null;
    const designation = (raw.designation ?? "").trim() || null;
    if (department && department.length > 80) errors.push("Department is longer than 80 characters.");
    if (designation && designation.length > 80) errors.push("Designation is longer than 80 characters.");

    const row: ImportRow | null =
      errors.length === 0 && email.success && role
        ? { full_name: name, email: email.data, phone, department, designation, role, date_of_joining: doj }
        : null;
    return { line, raw, row, errors };
  });
}

export const ImportPeopleSchema = z.object({
  rows: z
    .array(
      z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        department: z.string().optional(),
        designation: z.string().optional(),
        role: z.string().optional(),
        date_of_joining: z.string().optional(),
      }),
    )
    .min(1, { error: "The file has no rows to import." })
    .max(IMPORT_MAX_ROWS, { error: `Import at most ${IMPORT_MAX_ROWS} people at a time.` }),
});
export type ImportPeopleInput = z.input<typeof ImportPeopleSchema>;

/** A template users can download: the header row and one example. */
export const IMPORT_TEMPLATE_CSV = `${IMPORT_COLUMNS.join(",")}\nRavi Kumar,ravi.kumar@twchartered.com,98765 43210,GST,Senior associate,employee,2026-06-01\n`;

// -------------------------------------------------------------------------------------------------
// "Login created" (§4.5 point 2): the share message and the invite email
// -------------------------------------------------------------------------------------------------

export type LoginShare = { fullName: string; email: string; temporaryPassword: string; loginUrl: string; firmName: string };

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** The pre-drafted WhatsApp message: the login link, email and temporary password. */
export function loginShareMessage(s: LoginShare): string {
  return [
    `Hi ${firstWord(s.fullName)}, your ${s.firmName} login is ready.`,
    "",
    `Sign in: ${s.loginUrl}`,
    `Email: ${s.email}`,
    `Temporary password: ${s.temporaryPassword}`,
    "",
    "You'll set your own password when you first sign in.",
  ].join("\n");
}

/** The staff invite email (§10 item 1), as subject and plain text. */
export function loginInviteEmail(s: LoginShare, kind: "invite" | "reset"): { subject: string; text: string } {
  const subject =
    kind === "invite" ? `${s.firmName} | Your login to the practice app` : `${s.firmName} | Your password has been reset`;
  const opening =
    kind === "invite"
      ? `Hi ${firstWord(s.fullName)},\n\nA login has been created for you on ${s.firmName}'s practice app.`
      : `Hi ${firstWord(s.fullName)},\n\nYour password on ${s.firmName}'s practice app has been reset.`;
  const text = [
    opening,
    "",
    `Sign in: ${s.loginUrl}`,
    `Email: ${s.email}`,
    `Temporary password: ${s.temporaryPassword}`,
    "",
    "You'll set your own password when you first sign in. Partners and Managers also set up two-step sign-in with an authenticator app.",
    "",
    "If you didn't expect this email, tell a Partner.",
  ].join("\n");
  return { subject, text };
}

// -------------------------------------------------------------------------------------------------
// Capacity window for the team list and person pages (§7.11.4)
// -------------------------------------------------------------------------------------------------

/**
 * The window the team list measures capacity over: today and the next 13 days. Open tasks due in
 * it count, and so do overdue ones (they still have to be done), against the working days left.
 */
export const CAPACITY_WINDOW_DAYS = 14;

export function capacityWindow(today: DateString, days: number = CAPACITY_WINDOW_DAYS): { from: DateString; to: DateString } {
  return { from: today, to: addDays(today, days - 1) };
}

// -------------------------------------------------------------------------------------------------
// Display helpers
// -------------------------------------------------------------------------------------------------

export type LoginStatus = "active" | "disabled" | "no_login";

export const LOGIN_STATUS: Record<LoginStatus, { label: string; tone: "success" | "muted" | "warning"; meaning: string }> = {
  active: { label: "Active", tone: "success", meaning: "Active: has a login and can sign in." },
  disabled: {
    label: "Disabled",
    tone: "muted",
    meaning: "Disabled: can't sign in. Their history is kept, and a Partner or Manager can enable them again.",
  },
  no_login: {
    label: "No login yet",
    tone: "warning",
    meaning: "No login yet: the record exists but they can't sign in. Use Issue login to create one.",
  },
};

/** "Chrome on Windows" from a user agent; "Unknown device" when it can't tell. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  if (!ua) return "Unknown device";
  if (/TaxWiseDesktop|Electron/i.test(ua)) return "TaxWise Desktop";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iPhone"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

// -------------------------------------------------------------------------------------------------
// Performance (§7.11.2): filed on time %, average days late, review send-back rate, hours vs target
// -------------------------------------------------------------------------------------------------

/** Whole IST days between a due date and a completion instant (positive = late, 0 = on the day). */
export function daysLate(due: DateString, completedAt: string | Date): number {
  const ms = (typeof completedAt === "string" ? Date.parse(completedAt) : completedAt.getTime()) + 330 * 60_000;
  const done = new Date(ms).toISOString().slice(0, 10);
  return Math.round((Date.parse(`${done}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000);
}

export interface PerformanceFigures {
  filed: number;
  filedOnTime: number;
  filedLate: number;
  /** One decimal; null when nothing was late. */
  averageDaysLate: number | null;
  /** 0–100, one decimal; null when nothing was filed. */
  onTimePercent: number | null;
  submittedForReview: number;
  sentBack: number;
  /** 0–100, one decimal; null when nothing went for review. */
  sendBackPercent: number | null;
}

function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part * 1000) / whole) / 10;
}

/**
 * The person's performance figures from their filed tasks and their tasks' review history. A task
 * without a due date counts as on time. Send-back rate is sends back (Under review → In progress)
 * over submissions for review.
 */
export function summarisePerformance(
  filedTasks: ReadonlyArray<{ due_date: string | null; completion_date: string | null }>,
  reviewHistory: ReadonlyArray<{ from_status: string | null; to_status: string }>,
): PerformanceFigures {
  let onTime = 0;
  let late = 0;
  let lateDays = 0;
  for (const t of filedTasks) {
    if (!t.due_date || !t.completion_date) {
      onTime += 1;
      continue;
    }
    const d = daysLate(t.due_date, t.completion_date);
    if (d > 0) {
      late += 1;
      lateDays += d;
    } else onTime += 1;
  }
  let submitted = 0;
  let sentBack = 0;
  for (const h of reviewHistory) {
    if (h.to_status === "under_review") submitted += 1;
    else if (h.from_status === "under_review" && h.to_status === "in_progress") sentBack += 1;
  }
  return {
    filed: onTime + late,
    filedOnTime: onTime,
    filedLate: late,
    averageDaysLate: late > 0 ? Math.round((lateDays * 10) / late) / 10 : null,
    onTimePercent: pct(onTime, onTime + late),
    submittedForReview: submitted,
    sentBack,
    sendBackPercent: pct(sentBack, submitted),
  };
}

/** The hours target for a span of days: the weekly target spread evenly (48 h a week → 6.86 h a day). */
export function targetMinutesFor(weeklyHoursTarget: number, days: number): number {
  return Math.round((weeklyHoursTarget * 60 * Math.max(0, days)) / 7);
}
