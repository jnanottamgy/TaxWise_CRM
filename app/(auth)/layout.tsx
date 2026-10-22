import { BrandPanel, PhoneBrand, PhonePoweredBy } from "./_components/brand";

/**
 * Shell for sign-in, password, two-step sign-in, first run and no-access pages (§3.5).
 * Static on purpose: it loads nothing, so it can never throw (§0.1 rule 3).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-bg">
      <BrandPanel />
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center px-4 py-10 sm:px-8 md:py-12">
        <PhoneBrand />
        {children}
        <PhonePoweredBy />
      </main>
    </div>
  );
}
