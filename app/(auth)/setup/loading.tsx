import { AuthCardSkeleton } from "../_components/auth-card-skeleton";

export default function Loading() {
  return <AuthCardSkeleton title="Set up TaxWise" fields={6} size="lg" />;
}
