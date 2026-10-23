/**
 * Every email the system sends (§10), each returning `{ subject, html, text }` for sendEmail
 * (server/email/send.ts). Build the firm block once with `emailFirm(await getFirmProfile(supabase))`.
 *
 *   const firm = emailFirm(await getFirmProfile(ctx.supabase));
 *   const mail = invoiceEmail({ recipientName, clientName, invoiceNumber, … }, firm);
 *   const sent = await sendEmail({ to, ...mail, kind: "invoice", clientId, contactId,
 *     related: { type: "invoice", id }, attachments: [{ filename, content: pdf }],
 *     idempotencyKey: `invoice:${id}:send:${sendCount}` });
 */
export { emailFirm, emailSubject, renderEmail, renderPlainText, type EmailFirm, type RenderedEmail, type EmailBlock, type EmailContent, type DetailRow } from "@/server/email/templates/layout";
export { staffInviteEmail, type StaffInviteData } from "@/server/email/templates/staff-invite";
export { portalInviteEmail, type PortalInviteData } from "@/server/email/templates/portal-invite";
export { welcomeEmail, type WelcomeData } from "@/server/email/templates/welcome";
export {
  quotationSentEmail,
  quotationFollowUpEmail,
  quotationAcceptedEmail,
  quotationDeclinedEmail,
  quotationResponseAlertEmail,
  type QuotationSentData,
  type QuotationFollowUpData,
  type QuotationAcceptedData,
  type QuotationDeclinedData,
  type QuotationResponseAlertData,
} from "@/server/email/templates/quotation";
export { invoiceEmail, type InvoiceEmailData } from "@/server/email/templates/invoice";
export { paymentReceiptEmail, paymentReminderEmail, reminderTone, type PaymentReceiptData, type PaymentReminderData } from "@/server/email/templates/payments";
export { documentRequestEmail, type DocumentRequestData, type DocumentRequestItem } from "@/server/email/templates/document-request";
export { complianceReminderEmail, type ComplianceReminderData } from "@/server/email/templates/compliance-reminder";
export { engagementLetterEmail, type EngagementLetterData } from "@/server/email/templates/engagement-letter";
export { partnerDigestEmail, type PartnerDigestData, type DigestDeadline, type DigestReceivable, type DigestTask } from "@/server/email/templates/partner-digest";
export { notificationEmail, noticeEmail, testEmail, type NotificationEmailData, type NoticeEmailData, type TestEmailData } from "@/server/email/templates/notification";
export { passwordResetTemplate, SUPABASE_CONFIRMATION_URL } from "@/server/email/templates/password-reset";
