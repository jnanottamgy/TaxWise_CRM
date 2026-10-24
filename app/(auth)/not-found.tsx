import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AuthCard, TroubleLine } from "./_components/auth-card";

export const metadata = { title: "Page not found" };

/**
 * notFound() from an auth page (for example /setup once the first Partner exists, §4.3). The root
 * not-found is a whole page with its own brand band; inside this layout it would repeat the brand
 * panel and push the page past the viewport, so this one is just the card.
 */
export default function AuthNotFound() {
  return (
    <AuthCard
      title="Page not found"
      description="There's no page at this address. It may have been moved, or the link may be incomplete."
      footer={<TroubleLine />}
    >
      <Button asChild className="w-full">
        <Link href="/login">Go to sign in</Link>
      </Button>
    </AuthCard>
  );
}
