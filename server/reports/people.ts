import "server-only";

import { ROLE_LABEL, isAppRole } from "@/lib/auth/roles";
import { reportRpcParams } from "@/lib/schemas/reports";
import type { ReportResult, ReportRow } from "@/components/reports/report-types";
import { callReport, rate, reportHeader, type ReportLoader } from "@/server/reports/shared";

/**
 * People (§7.16): "hours, utilisation, attendance summary, leave". Per person: the time logged in the
 * period (finished entries only, by the day they started) and the billable share of it, which is the
 * timesheet's utilisation (§7.10: billable ÷ total); attendance days as the attendance records hold
 * them (§7.12); and approved leave counted in working days (the firm's working weekdays, holidays
 * left out; a half day counts 0.5). The client and service filters narrow the hours only. No rates or
 * costs are read. report_people (0213) counts it in SQL.
 */

type Raw = {
  kpis: { people: number; minutes: number; billable: number; absent: number; leave_days: number };
  by_person: Array<{
    employee_id: string;
    name: string;
    designation: string | null;
    role: string;
    is_active: boolean;
    minutes: number;
    billable: number;
    present: number;
    late_login: number;
    half_day: number;
    absent: number;
    on_leave: number;
    leave_annual: number;
    leave_sick: number;
    leave_casual: number;
    leave_other: number;
    leave_total: number;
  }>;
};

export const loadPeopleReport: ReportLoader = async (supabase, f, ctx) => {
  const [header, r] = await Promise.all([reportHeader(supabase, "people", f, ctx), callReport<Raw>(supabase, "report_people", reportRpcParams(f))]);
  const k = r.kpis;
  const sum = (key: keyof Raw["by_person"][number]) => r.by_person.reduce((n, p) => n + Number(p[key] ?? 0), 0);

  const person = (p: Raw["by_person"][number]) => {
    const role = isAppRole(p.role) ? ROLE_LABEL[p.role] : p.role;
    return { text: p.name, href: `/people/${p.employee_id}`, sub: [p.designation, role, p.is_active ? null : "Disabled"].filter(Boolean).join(" · ") || null };
  };

  const hours: ReportRow[] = r.by_person.map((p) => ({
    person: person(p),
    minutes: p.minutes,
    billable: p.billable,
    non_billable: p.minutes - p.billable,
    utilisation: rate(p.billable, p.minutes),
  }));

  const attendance: ReportRow[] = r.by_person.map((p) => ({
    person: person(p),
    present: p.present,
    late: p.late_login,
    half: p.half_day,
    absent: p.absent,
    on_leave: p.on_leave,
  }));

  const leave: ReportRow[] = r.by_person
    .filter((p) => p.leave_total > 0)
    .map((p) => ({
      person: person(p),
      annual: Number(p.leave_annual),
      sick: Number(p.leave_sick),
      casual: Number(p.leave_casual),
      other: Number(p.leave_other),
      total: Number(p.leave_total),
    }));

  const result: ReportResult = {
    ...header,
    kpis: [
      { label: "Utilisation", kind: "percent", value: rate(k.billable, k.minutes), sub: "Billable share of the hours logged" },
      { label: "Hours logged", kind: "hours", value: k.minutes, sub: `${r.by_person.filter((p) => p.minutes > 0).length} of ${k.people} people logged time` },
      { label: "Billable hours", kind: "hours", value: k.billable, href: "/timesheet?view=team" },
      { label: "Absent days", kind: "count", value: k.absent, sub: "As the attendance records hold them" },
      { label: "Leave taken", kind: "days", value: Number(k.leave_days), sub: "Approved, on working days", href: "/leave" },
    ],
    sections: [
      {
        id: "hours",
        title: "Hours and utilisation",
        description: "Finished time entries started in the period. Utilisation is billable hours out of all hours logged.",
        columns: [
          { key: "person", header: "Person", kind: "link", mobile: "primary" },
          { key: "minutes", header: "Hours", kind: "hours", mobile: "secondary" },
          { key: "billable", header: "Billable", kind: "hours", mobile: "secondary" },
          { key: "non_billable", header: "Not billable", kind: "hours", hideBelow: "lg" },
          { key: "utilisation", header: "Utilisation", kind: "percent", mobile: "trailing" },
        ],
        rows: hours,
        totals: hours.length > 1 ? { person: "Everyone", minutes: k.minutes, billable: k.billable, non_billable: k.minutes - k.billable, utilisation: rate(k.billable, k.minutes) } : null,
        empty: "No one is on the team list for this period.",
      },
      {
        id: "attendance",
        title: "Attendance",
        description: "Days by attendance status in the period, as recorded each day.",
        columns: [
          { key: "person", header: "Person", kind: "link", mobile: "primary" },
          { key: "present", header: "Present", kind: "count", mobile: "trailing" },
          { key: "late", header: "Late login", kind: "count", mobile: "secondary" },
          { key: "half", header: "Half day", kind: "count", mobile: "secondary" },
          { key: "absent", header: "Absent", kind: "count", mobile: "secondary" },
          { key: "on_leave", header: "On leave", kind: "count", hideBelow: "lg" },
        ],
        rows: attendance,
        totals: attendance.length > 1 ? { person: "Everyone", present: sum("present"), late: sum("late_login"), half: sum("half_day"), absent: sum("absent"), on_leave: sum("on_leave") } : null,
        empty: "No attendance was recorded in this period.",
        half: true,
      },
      {
        id: "leave",
        title: "Leave",
        description: "Approved leave falling in the period, in working days.",
        columns: [
          { key: "person", header: "Person", kind: "link", mobile: "primary" },
          { key: "annual", header: "Annual", kind: "days", hideBelow: "lg" },
          { key: "sick", header: "Sick", kind: "days", mobile: "secondary" },
          { key: "casual", header: "Casual", kind: "days", mobile: "secondary" },
          { key: "other", header: "Other", kind: "days", hideBelow: "lg" },
          { key: "total", header: "Total", kind: "days", mobile: "trailing" },
        ],
        rows: leave,
        totals: leave.length > 1 ? { person: "Everyone", annual: sum("leave_annual"), sick: sum("leave_sick"), casual: sum("leave_casual"), other: sum("leave_other"), total: sum("leave_total") } : null,
        empty: "No approved leave falls in this period.",
        half: true,
      },
    ],
  };
  return result;
};
