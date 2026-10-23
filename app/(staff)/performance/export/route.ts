import { NextResponse, type NextRequest } from "next/server"
import ExcelJS from "exceljs"
import { getSession } from "@/lib/auth/current-user"
import { can, ROLE_LABEL } from "@/lib/auth/roles"
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa"
import { logUnexpected } from "@/lib/log"
import { unexpectedMessage } from "@/lib/result"
import { todayIST } from "@/lib/domain/fy"
import { ATTENDANCE_STATUS_LABELS } from "@/lib/domain/attendance"
import { formatDateShort } from "@/lib/format"
import { getTeamAttendance } from "@/lib/data/attendance"
import { isMonth, monthLabel } from "@/lib/schemas/leave"

/**
 * Attendance exports (§7.12, §11 "attendance report"): `?month=YYYY-MM&kind=report|summary&format=csv|xlsx`.
 *   report   person × day: each working day's status (Present, Late login, Half day, Absent, On leave)
 *   summary  per person: present, late, half days, absent, leave, active hours
 * Partners and Managers only (§4.1), at two-step sign-in; read under their own session (RLS); every
 * export writes an export_run audit row first, and isn't made if that fails (§12). Cells that start like a formula are quoted so a
 * spreadsheet never runs them.
 */
export const dynamic = "force-dynamic"

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status })
  res.headers.set("Cache-Control", "no-store")
  return res
}

/** Neutralises spreadsheet formulas (CSV/formula injection). */
function safeCell(v: string | number): string | number {
  if (typeof v === "number") return v
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
}

function csvField(v: string | number): string {
  const s = String(safeCell(v))
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows: Array<Array<string | number>>): string {
  return `﻿${rows.map((r) => r.map(csvField).join(",")).join("\r\n")}\r\n`
}

async function toXlsx(sheet: string, title: string, rows: Array<Array<string | number>>, firstDataColumn: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "TaxWise Consultants"
  wb.created = new Date()
  const ws = wb.addWorksheet(sheet, { views: [{ state: "frozen", xSplit: 1, ySplit: 2 }] })
  ws.addRow([title]).font = { bold: true, size: 12 }
  const [header, ...body] = rows
  const h = ws.addRow(header)
  h.font = { bold: true }
  h.alignment = { vertical: "middle" }
  for (const r of body) ws.addRow(r.map(safeCell))
  ws.columns.forEach((col, i) => {
    col.width = i === 0 ? 28 : i < firstDataColumn ? 16 : 12
  })
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

export async function GET(request: NextRequest) {
  let userId: string | null = null
  try {
    const session = await getSession()
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401)
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403)
    const { user, supabase } = session
    userId = user.id
    if (!can.managePeople(user.role)) return json({ ok: false, error: "Only Partners and Managers export attendance.", code: "forbidden" }, 403)
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403)
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (mfaRequiredFor(user.role) && toAal(aal?.currentLevel) !== "aal2") {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403)
    }

    const p = request.nextUrl.searchParams
    const current = todayIST().slice(0, 7)
    const month = p.get("month") ?? current
    const kind = p.get("kind") === "summary" ? "summary" : "report"
    const format = p.get("format") === "csv" ? "csv" : "xlsx"
    if (!isMonth(month) || month > current) return json({ ok: false, error: "Choose a month up to this one.", code: "validation" }, 400)

    const data = await getTeamAttendance(supabase, month)
    const title = `${kind === "report" ? "Attendance report" : "Attendance summary"}, ${monthLabel(month)}`
    let rows: Array<Array<string | number>>
    let firstData: number
    if (kind === "report") {
      rows = [
        ["Person", "Designation", "Role", ...data.dates.map((d) => formatDateShort(d))],
        ...data.rows.map((r) => [r.full_name, r.designation ?? "", ROLE_LABEL[r.role], ...data.dates.map((d) => (r.byDate[d] ? ATTENDANCE_STATUS_LABELS[r.byDate[d]!] : ""))]),
      ]
      firstData = 3
    } else {
      rows = [
        ["Person", "Designation", "Role", "Present", "Late login", "Half day", "Absent", "On leave", "Active hours"],
        ...data.rows.map((r) => [
          r.full_name,
          r.designation ?? "",
          ROLE_LABEL[r.role],
          r.summary.present,
          r.summary.lateLogin,
          r.summary.halfDay,
          r.summary.absent,
          r.summary.onLeave,
          Math.round((r.summary.workMinutes / 60) * 10) / 10,
        ]),
      ]
      firstData = 3
    }

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "attendance_records",
      p_resource_id: month,
      p_action: `attendance.export_${kind}`,
      p_details: { month, kind, format, people: data.rows.length },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      p_user_agent: request.headers.get("user-agent"),
    })
    if (auditError) {
      // An export nobody can trace isn't made (§12).
      const ref = logUnexpected(auditError, { source: "route:/performance/export:audit", userId })
      return json({ ok: false, error: unexpectedMessage(ref), ref }, 500)
    }

    const name = `attendance-${kind}-${month}.${format}`
    const body = format === "csv" ? toCsv(rows) : await toXlsx(kind === "report" ? "Report" : "Summary", title, rows, firstData)
    return new NextResponse(typeof body === "string" ? body : new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    const ref = logUnexpected(err, { source: "route:/performance/export", userId })
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500)
  }
}
