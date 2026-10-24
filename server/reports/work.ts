import "server-only";

import { reportRpcParams } from "@/lib/schemas/reports";
import type { ReportResult, ReportRow } from "@/components/reports/report-types";
import { callReport, rate, reportHeader, SCREEN_LIST_ROWS, type ReportLoader } from "@/server/reports/shared";

/**
 * Work (§7.16): "tasks created/filed per person; average time to file; send-back rate; data-awaited
 * ageing". Per assignee: tasks created and filed (Filed/Done) in the period, the average days from
 * creation to filing of those filed, submissions for review and the send-backs among them (a move
 * from Under review back to In progress, §7.6.4) in the period, and what each holds today. Ageing
 * counts the days since each task last moved to Data awaited. report_work (0213) counts it in SQL.
 */

type Raw = {
  kpis: { created: number; filed: number; avg_days_to_file: number | null; submitted: number; sent_back: number; data_awaited: number; overdue_now: number };
  by_person: Array<{ employee_id: string | null; name: string | null; designation: string | null; created: number; filed: number; avg_days_to_file: number | null; submitted: number; sent_back: number; open_now: number; overdue_now: number; data_awaited: number }>;
  ageing: Array<{ bucket: string; label: string; tasks: number }>;
  longest_waiting: Array<{ task_id: string; task_number: string; title: string; client_id: string; client_name: string; assignee: string | null; due_date: string | null; days_waiting: number }>;
};

export const loadWorkReport: ReportLoader = async (supabase, f, ctx) => {
  const [header, r] = await Promise.all([reportHeader(supabase, "work", f, ctx), callReport<Raw>(supabase, "report_work", reportRpcParams(f))]);
  const k = r.kpis;

  const people: ReportRow[] = r.by_person.map((p) => ({
    person: p.employee_id ? (p.name ?? "Someone no longer listed") : "Not assigned",
    created: p.created,
    filed: p.filed,
    avg_days: p.avg_days_to_file === null ? null : Number(p.avg_days_to_file),
    submitted: p.submitted,
    sent_back: p.sent_back,
    send_back_rate: rate(p.sent_back, p.submitted),
    open: p.open_now,
    overdue: p.overdue_now,
    data_awaited: p.data_awaited,
  }));

  const waitingTotal = r.ageing.reduce((n, a) => n + a.tasks, 0);
  const waiting = (ctx.forExport ? r.longest_waiting : r.longest_waiting.slice(0, SCREEN_LIST_ROWS)).map((w) => ({
    task: { text: `${w.task_number} · ${w.title}`, href: `/work/${w.task_id}` },
    client: w.client_name,
    assignee: w.assignee ?? "Not assigned",
    due: w.due_date,
    days: w.days_waiting,
  }));

  const result: ReportResult = {
    ...header,
    kpis: [
      { label: "Filed", kind: "count", value: k.filed, sub: `${k.created} created in the period` },
      { label: "Average time to file", kind: "days", value: k.avg_days_to_file === null ? null : Number(k.avg_days_to_file), sub: "From creation to Filed/Done" },
      { label: "Send-back rate", kind: "percent", value: rate(k.sent_back, k.submitted), sub: k.submitted ? `${k.sent_back} of ${k.submitted} reviews sent back` : "No reviews in the period" },
      { label: "Data awaited now", kind: "count", value: k.data_awaited, sub: "Waiting for the client", href: "/work?status=data_awaited&sort=due_date&dir=asc" },
      { label: "Overdue now", kind: "count", value: k.overdue_now, sub: "Open past the due date" },
    ],
    sections: [
      {
        id: "by-person",
        title: "By person",
        description: "Created and filed count the period; open, overdue and data awaited are as of today.",
        columns: [
          { key: "person", header: "Assigned to", kind: "text", mobile: "primary" },
          { key: "created", header: "Created", kind: "count", mobile: "secondary" },
          { key: "filed", header: "Filed", kind: "count", mobile: "trailing" },
          { key: "avg_days", header: "Avg days to file", kind: "days", mobile: "secondary" },
          { key: "submitted", header: "Sent for review", kind: "count", hideBelow: "lg" },
          { key: "sent_back", header: "Sent back", kind: "count", hideBelow: "lg" },
          { key: "send_back_rate", header: "Send-back rate", kind: "percent", mobile: "secondary" },
          { key: "open", header: "Open", kind: "count", hideBelow: "xl" },
          { key: "overdue", header: "Overdue", kind: "count", hideBelow: "lg" },
          { key: "data_awaited", header: "Data awaited", kind: "count", hideBelow: "xl" },
        ],
        rows: people,
        totals:
          people.length > 1
            ? {
                person: "Everyone",
                created: k.created,
                filed: k.filed,
                avg_days: k.avg_days_to_file === null ? null : Number(k.avg_days_to_file),
                submitted: k.submitted,
                sent_back: k.sent_back,
                send_back_rate: rate(k.sent_back, k.submitted),
                open: r.by_person.reduce((n, p) => n + p.open_now, 0),
                overdue: k.overdue_now,
                data_awaited: k.data_awaited,
              }
            : null,
        empty: "No tasks were created, filed or reviewed in this period.",
      },
      {
        id: "ageing",
        title: "Data-awaited ageing",
        description: "Tasks waiting for the client's data today, by how long they have waited.",
        columns: [
          { key: "bucket", header: "Waiting", kind: "text", mobile: "primary" },
          { key: "tasks", header: "Tasks", kind: "count", mobile: "trailing" },
          { key: "share", header: "Share", kind: "percent", mobile: "secondary" },
        ],
        rows: r.ageing.map((a) => ({ bucket: a.label, tasks: a.tasks, share: rate(a.tasks, waitingTotal) })),
        totals: { bucket: "All waiting", tasks: waitingTotal, share: waitingTotal ? 100 : null },
        empty: "No task is waiting for data.",
        chart: { x: "bucket", y: "tasks", label: "Tasks", xLabel: "Waiting", format: "number" },
        half: true,
      },
      {
        id: "longest",
        title: "Longest waiting for data",
        description: "Call these clients first.",
        columns: [
          { key: "task", header: "Task", kind: "link", mobile: "primary" },
          { key: "client", header: "Client", kind: "text", mobile: "secondary" },
          { key: "assignee", header: "Assigned to", kind: "text", hideBelow: "lg" },
          { key: "due", header: "Due", kind: "date", hideBelow: "lg" },
          { key: "days", header: "Waiting", kind: "days", mobile: "trailing" },
        ],
        rows: waiting,
        total: r.longest_waiting.length < waitingTotal ? waitingTotal : r.longest_waiting.length,
        more: waitingTotal > waiting.length ? { label: `View all ${waitingTotal} in the work tracker`, href: "/work?status=data_awaited&sort=due_date&dir=asc" } : null,
        empty: "No task is waiting for data.",
        half: true,
      },
    ],
  };
  return result;
};
