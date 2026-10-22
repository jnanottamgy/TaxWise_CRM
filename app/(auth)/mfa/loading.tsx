import { AuthCardSkeleton } from "../_components/auth-card-skeleton";

export default function Loading() {
  return <AuthCardSkeleton title="Two-step sign-in" fields={1} />;
}
