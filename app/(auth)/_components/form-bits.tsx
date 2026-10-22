"use client";

import { useState } from "react";
import { CheckIcon, CircleAlertIcon, CircleCheckIcon, CircleIcon, EyeIcon, EyeOffIcon, InfoIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/app/copy-button";
import { checkPassword } from "@/lib/auth/password-policy";
import { cn } from "@/lib/utils";
import type { FormNotice } from "./use-auth-form";

// -------------------------------------------------------------------------------------------------
// Form-level message
// -------------------------------------------------------------------------------------------------

type Tone = "danger" | "warning" | "info" | "success";

const TONE: Record<Tone, { box: string; icon: string; Icon: typeof InfoIcon }> = {
  danger: { box: "border-danger/30 bg-danger-soft text-danger-text", icon: "text-danger-text", Icon: CircleAlertIcon },
  warning: { box: "border-warning/40 bg-warning-soft text-warning-text", icon: "text-warning-text", Icon: TriangleAlertIcon },
  info: { box: "border-info/30 bg-info-soft text-text", icon: "text-info-text", Icon: InfoIcon },
  success: { box: "border-success/30 bg-success-soft text-text", icon: "text-success-text", Icon: CircleCheckIcon },
};

/**
 * One sentence above the form. Errors are announced (`role="alert"`) and take focus after a failed
 * submit; notices are polite (`role="status"`). Unexpected errors carry a Ref with a copy button.
 */
export function FormMessage({
  notice,
  tone = "danger",
  alertRef,
  children,
}: {
  notice?: FormNotice | null;
  tone?: Tone;
  alertRef?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
}) {
  if (!notice && !children) return null;
  const t = TONE[tone];
  return (
    <div
      ref={alertRef}
      tabIndex={-1}
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        t.box,
      )}
    >
      <t.Icon aria-hidden="true" className={cn("mt-px size-4 flex-none", t.icon)} />
      <div className="flex min-w-0 flex-col gap-1">
        {notice ? <p>{notice.message}</p> : null}
        {children}
        {notice?.ref ? (
          <span className="inline-flex items-center gap-1 text-xs">
            {notice.message.includes(notice.ref) ? null : <span className="num">Ref {notice.ref}</span>}
            <CopyButton value={notice.ref} label="Ref" showText />
          </span>
        ) : null}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Submit button with a spinner (§3.5)
// -------------------------------------------------------------------------------------------------

export function SubmitButton({
  busy,
  busyText,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { busy: boolean; busyText: string }) {
  return (
    <Button type="submit" size="lg" disabled={busy} aria-disabled={busy} className={cn("w-full", className)} {...props}>
      {busy ? (
        <>
          <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
          <span>{busyText}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
}

// -------------------------------------------------------------------------------------------------
// Password with show/hide (§3.5) and the live policy checklist (§4.4)
// -------------------------------------------------------------------------------------------------

export function PasswordInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn("h-10 pr-11", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={props.id}
        className="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center rounded-r-md text-text-muted transition-colors duration-150 hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:w-11"
      >
        {visible ? <EyeOffIcon aria-hidden="true" className="size-4" /> : <EyeIcon aria-hidden="true" className="size-4" />}
      </button>
    </div>
  );
}

export function PasswordChecklist({ id, password, columns = 1 }: { id: string; password: string; columns?: 1 | 2 }) {
  const checks = checkPassword(password ?? "");
  return (
    <ul id={id} aria-label="Your password needs" className={cn("grid gap-x-4 gap-y-1.5 text-sm", columns === 2 && "sm:grid-cols-2")}>
      {checks.map((c) => (
        <li key={c.rule} className={cn("flex items-center gap-2 transition-colors duration-150", c.ok ? "text-text" : "text-text-muted")}>
          {c.ok ? (
            <CheckIcon aria-hidden="true" className="size-3.5 flex-none text-success-text" strokeWidth={2.5} />
          ) : (
            <CircleIcon aria-hidden="true" className="size-3.5 flex-none text-text-muted" />
          )}
          <span>{c.label}</span>
          <span className="sr-only">{c.ok ? ": done" : ": not yet"}</span>
        </li>
      ))}
    </ul>
  );
}

/** A field's error line, in the AA-safe danger text colour. */
export function FieldMessage({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-danger-text">
      {message}
    </p>
  );
}

/** Label, control, helper and error, stacked with 8px gaps (DESIGN.md §5). */
export function FormField({
  label,
  htmlFor,
  required,
  helper,
  helperId,
  error,
  errorId,
  aside,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  helper?: React.ReactNode;
  helperId?: string;
  error?: string;
  errorId?: string;
  /** Right side of the label row. */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium text-text">
          {label}
          {required ? (
            <span aria-hidden="true" className="ml-0.5 text-danger-text">
              *
            </span>
          ) : null}
        </label>
        {aside}
      </div>
      {children}
      {helper ? (
        <div id={helperId} className="text-sm text-text-muted">
          {helper}
        </div>
      ) : null}
      <FieldMessage id={errorId ?? `${htmlFor}-error`} message={error} />
    </div>
  );
}

/** aria-describedby for a control: its helper and, when present, its error. */
export function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const list = ids.filter(Boolean).join(" ");
  return list || undefined;
}
