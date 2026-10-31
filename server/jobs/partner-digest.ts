import "server-only";

/**
 * Partner daily digest, 08:00 IST (§8, §7.17): retired. It was only ever an email to each Partner,
 * and the firm sends no email; the dashboard and the Inbox show the same things (today's
 * deadlines, approvals waiting, overdue receivables, unassigned work) whenever a Partner opens the
 * app. Kept as a harmless job so the schedule still resolves until it is taken off: it does
 * nothing, and its counts say so (`retired_no_email`).
 */
export async function run(): Promise<{ counts: Record<string, number> }> {
  return { counts: { retired_no_email: 1 } };
}
