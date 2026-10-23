/**
 * Bulk WhatsApp reminders (§7.13.2), for any screen with a filtered list:
 *
 *   import { BulkReminderLauncher } from "@/components/bulk-queue"
 *   <BulkReminderLauncher source={{ kind: "tasks", ids }} label="Remind all on WhatsApp" />
 *
 * BulkWhatsAppQueue takes ready-made steps ({ clientId, contactId, number, draft, … }) when the
 * caller builds its own drafts; BulkReminderBuilder is the /messages "Bulk reminders" dialog.
 */
export { BulkReminderLauncher } from "@/components/bulk-queue/bulk-reminder-launcher"
export { BulkWhatsAppQueue } from "@/components/bulk-queue/bulk-whatsapp-queue"
export { BulkReminderBuilder, type BuilderTemplate } from "@/components/bulk-queue/bulk-reminder-builder"
export type { BulkSource, QueueStep, QueueSkip } from "@/lib/schemas/inbox"
