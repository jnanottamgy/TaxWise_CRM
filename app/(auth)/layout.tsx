import { BrandPanel, PhoneBrand, PhonePoweredBy } from "./_components/brand";

/**
 * Shell for sign-in, password, two-step sign-in, first run and no-access pages (§3.5).
 * Static on purpose: it loads nothing, so it can never throw (§0.1 rule 3).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    // The navy binder (DESIGN.md §2): the brand panel on the navy frame, the form on a paper sheet.
    <div className="flex min-h-dvh bg-bg md:bg-frame">
      <BrandPanel />
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center bg-bg px-4 py-10 sm:px-8 md:my-2.5 md:mr-2.5 md:rounded-2xl md:py-12">
        <PhoneBrand />
        {children}
        <PhonePoweredBy />
      </main>
    </div>
  );
}
