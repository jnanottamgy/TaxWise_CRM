import type { ReportSlug } from "@/lib/schemas/reports"

/**
 * The Help panel for each report (§3.3 "help opens the in-app guide for that page"): how each figure
 * is counted, in the firm's words. Server-safe.
 */
export const REPORT_GUIDE: Readonly<Record<ReportSlug, React.ReactNode>> = {
  compliance: (
    <>
      <p>Each statutory return due in the period counts once: filed on time when it was marked filed on or before its due date, late when after, overdue when it is still not filed after its due date. A government extension moves the due date first, so a return filed by the extended date is on time.</p>
      <p className="mt-2">Upcoming load counts returns still to file in each of the next eight weeks, whatever period you chose. Overdue by owner groups everything past its due date by the client&apos;s owner.</p>
      <p className="mt-2">Prepared by narrows the returns to those whose task is assigned to that person.</p>
    </>
  ),
  work: (
    <>
      <p>Created and filed count tasks by the day they were created and the day they were set to Filed/Done. Average time to file is the days from creation to Filed/Done, for the tasks filed in the period.</p>
      <p className="mt-2">Sent for review counts moves to Under review in the period; sent back counts reviews returned to In progress. The send-back rate is one out of the other.</p>
      <p className="mt-2">Data-awaited ageing counts the days since each task last moved to Data awaited, as of today.</p>
    </>
  ),
  clients: (
    <>
      <p>Every client outside the recycle bin counts. A client joins on the day its onboarding was completed; clients added before onboarding existed count from the day they were added.</p>
      <p className="mt-2">Made inactive lists clients whose status was last changed to Inactive in the period and who are still inactive, with the reason given at the time.</p>
      <p className="mt-2">By service counts clients with an active engagement for the service; a client with three services counts under each.</p>
    </>
  ),
  revenue: (
    <>
      <p>Agreed is the fee agreed on each engagement for every billing period of the FY that has started, at the fee in force then. Invoiced is the fee on issued invoices, without GST or reimbursements, less credit notes. Collected is what came in against those fees, received plus TDS.</p>
      <p className="mt-2">Billing % is invoiced out of agreed; realisation % is collected out of invoiced. Periods not invoiced are ended billing periods of active engagements with no invoice raised; a draft counts as raised.</p>
      <p className="mt-2">This report is kept per financial year. The same figures, engagement by engagement, are on the Fee realisation page.</p>
    </>
  ),
  collections: (
    <>
      <p>Receivables are issued invoices that are Sent, Partially paid or Disputed, with a balance, aged by days since the invoice date. A draft is never a receivable.</p>
      <p className="mt-2">The collection rate is what came in (received plus TDS) out of what there was to collect in the period: what was open on its first day, plus what was invoiced, less credit notes and write-offs.</p>
      <p className="mt-2">Promises are the latest promised payment date logged on an invoice, falling in the period. Received counts payments recorded after the promise was logged.</p>
    </>
  ),
  people: (
    <>
      <p>Hours are finished time entries, by the day they started. Utilisation is billable hours out of all the hours logged, as on the team timesheet.</p>
      <p className="mt-2">Attendance counts each day as the attendance record holds it, corrections included. Leave counts approved leave on the firm&apos;s working days, holidays left out; a half day counts as half.</p>
      <p className="mt-2">Client and service narrow the hours only. No billing or cost rates are used here.</p>
    </>
  ),
  pipeline: (
    <>
      <p>Leads count by the day they were created; won and lost by the day they were closed. Conversion is won out of those closed in the period.</p>
      <p className="mt-2">Quotations count as sent by the day they were sent and as accepted, rejected or expired by the day that happened. The win rate is accepted out of those decided. Values are before GST.</p>
      <p className="mt-2">Open quotations are those pending approval, approved, sent or viewed and still within their validity, today.</p>
    </>
  ),
  practice: (
    <>
      <p>The UDIN register lists UDINs for reports signed in the period, newest first. A UDIN generated more than the allowed days after signing (60) is marked late.</p>
      <p className="mt-2">The tax-audit ceiling counts each partner&apos;s tax audit reports signed in the FY of the period&apos;s end, with the audits they signed elsewhere, against the ceiling in force (60). Form 3CB under s.44AB(c), (d) and (e), revised reports and branch audits of the same assessee don&apos;t count again.</p>
      <p className="mt-2">Expiries list active DSCs and registrations already past their expiry date or expiring within 90 days. Engagement letters cover active clients with an active service; a client is covered by a letter for the FY at Issued or Signed.</p>
    </>
  ),
}
