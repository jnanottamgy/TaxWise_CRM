import { z } from "zod";
import { isValidEmailAddress, normaliseDomain } from "@/server/email/policy";

/**
 * Settings → Email forms (§7.13.5, §7.21), shared by the forms and server/actions/email-settings.ts.
 * Client-safe (server/email/policy.ts is pure).
 */

export const RESEND_REGION_VALUES = ["ap-northeast-1", "us-east-1", "eu-west-1", "sa-east-1"] as const;

export const DomainSetupSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1, { error: "Enter the domain you send email from, e.g. twchartered.com." })
    .transform((v, ctx) => {
      const d = normaliseDomain(v);
      if (!d) {
        ctx.addIssue({ code: "custom", message: "That isn't a domain name. Enter it without http:// or a path, e.g. twchartered.com." });
        return z.NEVER;
      }
      return d;
    }),
  region: z.enum(RESEND_REGION_VALUES, { error: "Choose where Resend sends from." }),
});
export type DomainSetupInput = z.input<typeof DomainSetupSchema>;

export const DomainRefreshSchema = z.object({
  /** Ask Resend to check the DNS records now (Check now), not only read its status (polling). */
  verify: z.boolean().default(false),
});

export const DomainRemoveSchema = z.object({
  /** The domain the person saw on screen, so a stale page can't remove a different one. */
  domain: z.string().trim().min(1),
});

const address = (what: string) =>
  z
    .string()
    .trim()
    .min(1, { error: `Enter the ${what}.` })
    .max(254, { error: "That address is too long." })
    .refine((v) => isValidEmailAddress(v), { error: "Enter a valid email address, like info@twchartered.com." });

export const SenderSchema = z.object({
  email_from_name: z
    .string()
    .trim()
    .min(1, { error: "Enter the name clients see as the sender." })
    .max(80, { error: "Keep the sender name under 80 characters." })
    .refine((v) => !/[<>"\r\n]/.test(v), { error: "The sender name can't contain < > or quotes." }),
  email_from_address: address("from address"),
  email_reply_to: address("reply-to address"),
  /** What the form loaded, for the concurrency check on these three columns (§13). */
  was_from_name: z.string(),
  was_from_address: z.string(),
  was_reply_to: z.string(),
});
export type SenderInput = z.input<typeof SenderSchema>;

export const TestSendSchema = z.object({});
