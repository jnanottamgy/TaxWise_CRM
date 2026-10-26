import { cn } from "@/lib/utils";

/**
 * The centred card on every auth page: a serif title, one line under it, the form, and an
 * optional footer line outside the card. Bordered, no shadow at rest (DESIGN.md §3).
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
  size = "sm",
  className,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** sm: sign-in forms (400px) · md: authenticator set-up (520px) · lg: the two-column first-run form (720px). */
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const width = size === "lg" ? "max-w-[720px]" : size === "md" ? "max-w-[520px]" : "max-w-[400px]";
  return (
    <div className={cn("flex w-full flex-col gap-5", width, className)}>
      <section aria-labelledby="auth-title" className="rounded-xl border border-border bg-surface p-6 sm:p-9">
        <header className="mb-7 flex flex-col gap-1.5">
          <h1 id="auth-title" className="font-serif text-[24px] leading-8 font-[450] tracking-[-0.015em] text-text sm:text-[30px] sm:leading-9">
            {title}
          </h1>
          {description ? <div className="text-sm text-text-muted">{description}</div> : null}
        </header>
        {children}
      </section>
      {footer ? <div className="px-2 text-center text-sm text-text-muted">{footer}</div> : null}
    </div>
  );
}

/** "Trouble signing in? Ask a Partner to reset your access." (§3.5) */
export function TroubleLine() {
  return <p>Trouble signing in? Ask a Partner to reset your access.</p>;
}
