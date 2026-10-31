/**
 * Zod schemas for sign-in, password, MFA and first-run forms (§4.3, §4.4, §12).
 * Shared by the client forms (react-hook-form + zodResolver) and the server actions. Client-safe.
 */

import { z } from "zod";
import { PASSWORD_MAX_LENGTH, passwordPolicyMessage } from "@/lib/auth/password-policy";
import {
  gstinPanMismatch,
  isValidStateCode,
  normaliseIdentifier,
  validateGstin,
  validatePan,
  validatePincode,
} from "@/lib/domain/india-validators";

export const emailField = z
  .string({ error: "Enter your email address." })
  .trim()
  .toLowerCase()
  .min(1, { error: "Enter your email address." })
  .max(254, { error: "That email address is too long." })
  .pipe(z.email({ error: "Enter a valid email address, like name@example.com." }));

/** A new password: the §4.4 policy, checked with the same function as the live checklist. */
export const newPasswordField = z
  .string({ error: "Enter a password." })
  .superRefine((value, ctx) => {
    const message = passwordPolicyMessage(value);
    if (message) ctx.addIssue({ code: "custom", message });
  });

/** Where to go after signing in. Only checked for shape here; the server re-checks it (safeNextPath). */
const nextField = z.string().max(2048).optional();

// -------------------------------------------------------------------------------------------------
// Sign in, forgot password, new password
// -------------------------------------------------------------------------------------------------

export const SignInSchema = z.object({
  email: emailField,
  // Never trimmed: spaces are legal password characters.
  password: z
    .string({ error: "Enter your password." })
    .min(1, { error: "Enter your password." })
    .max(PASSWORD_MAX_LENGTH * 4, { error: "Email or password is incorrect." }),
  next: nextField,
});
export type SignInInput = z.input<typeof SignInSchema>;


export const NewPasswordSchema = z
  .object({
    password: newPasswordField,
    confirm: z.string({ error: "Type the new password again." }).min(1, { error: "Type the new password again." }),
  })
  .refine((d) => d.password === d.confirm, { path: ["confirm"], error: "The two passwords don't match." });
export type NewPasswordInput = z.input<typeof NewPasswordSchema>;

// -------------------------------------------------------------------------------------------------
// Two-step sign-in (TOTP, §12)
// -------------------------------------------------------------------------------------------------

export const MfaCodeSchema = z.object({
  factorId: z.uuid({ error: "Start again: the authenticator setup has expired." }),
  code: z
    .string({ error: "Enter the 6-digit code from your authenticator app." })
    .transform((v) => v.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^[0-9]{6}$/, { error: "Enter the 6-digit code from your authenticator app." })),
  next: nextField,
});
export type MfaCodeInput = z.input<typeof MfaCodeSchema>;

// -------------------------------------------------------------------------------------------------
// First run (§4.3): the first Partner and the firm's details (§1, pre-filled)
// -------------------------------------------------------------------------------------------------

const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, { error: tooLong })
    .optional()
    .transform((v) => (v ? v : undefined));

export const SetupSchema = z
  .object({
    fullName: z
      .string({ error: "Enter your full name." })
      .trim()
      .min(2, { error: "Enter your full name." })
      .max(120, { error: "Use 120 characters or fewer." }),
    email: emailField,
    password: newPasswordField,
    confirm: z.string({ error: "Type the password again." }).min(1, { error: "Type the password again." }),

    firmName: z
      .string({ error: "Enter the firm's name." })
      .trim()
      .min(2, { error: "Enter the firm's name." })
      .max(120, { error: "Use 120 characters or fewer." }),
    tagline: optionalText(120, "Use 120 characters or fewer."),
    address: z
      .string({ error: "Enter the registered address." })
      .trim()
      .min(5, { error: "Enter the registered address." })
      .max(300, { error: "Use 300 characters or fewer." }),
    city: z
      .string({ error: "Enter the city." })
      .trim()
      .min(2, { error: "Enter the city." })
      .max(80, { error: "Use 80 characters or fewer." }),
    stateCode: z
      .string({ error: "Choose the state." })
      .trim()
      .refine((v) => isValidStateCode(v), { error: "Choose the state." }),
    pincode: z
      .string({ error: "Enter the pincode." })
      .superRefine((v, ctx) => {
        const r = validatePincode(v);
        if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
      })
      .transform((v) => v.replace(/\s+/g, "")),
    phone: optionalText(20, "Use 20 characters or fewer.").refine(
      (v) => v === undefined || /^\+?[0-9][0-9\s-]{6,18}$/.test(v),
      { error: "Enter a phone number, like +91 97405 40239." },
    ),
    firmEmail: emailField,
    website: optionalText(200, "Use 200 characters or fewer.").refine(
      (v) => v === undefined || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v),
      { error: "Enter the full address, like https://www.twchartered.com/." },
    ),
    gstin: z
      .string()
      .optional()
      .transform((v) => (v ? normaliseIdentifier(v) : undefined))
      .superRefine((v, ctx) => {
        if (!v) return;
        const r = validateGstin(v);
        if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
      }),
    pan: z
      .string()
      .optional()
      .transform((v) => (v ? normaliseIdentifier(v) : undefined))
      .superRefine((v, ctx) => {
        if (!v) return;
        const r = validatePan(v);
        if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
      }),
  })
  .superRefine((d, ctx) => {
    if (d.password !== d.confirm) {
      ctx.addIssue({ code: "custom", path: ["confirm"], message: "The two passwords don't match." });
    }
    const mismatch = gstinPanMismatch(d.gstin, d.pan);
    if (mismatch) ctx.addIssue({ code: "custom", path: ["pan"], message: mismatch });
    if (d.gstin && d.gstin.slice(0, 2) !== d.stateCode) {
      ctx.addIssue({
        code: "custom",
        path: ["stateCode"],
        message: `The GSTIN is registered in state ${d.gstin.slice(0, 2)}. Choose that state, or check the GSTIN.`,
      });
    }
  });
export type SetupInput = z.input<typeof SetupSchema>;
export type SetupValues = z.output<typeof SetupSchema>;

/** Profile's change password (§7.1): current, new, confirm. */
export const ChangePasswordSchema = z
  .object({
    current: z.string({ error: "Enter your current password." }).min(1, { error: "Enter your current password." }),
    password: newPasswordField,
    confirm: z.string({ error: "Type the new password again." }).min(1, { error: "Type the new password again." }),
  })
  .refine((d) => d.password === d.confirm, { path: ["confirm"], error: "The two passwords don't match." })
  .refine((d) => d.password !== d.current, { path: ["password"], error: "Choose a password different from the one you use now." });
export type ChangePasswordInput = z.input<typeof ChangePasswordSchema>;
