import type { ClientTabProps } from "@/components/client360/types";
import { EmptyState } from "@/components/app/empty-state";

/** Client 360 → Documents tab (§7.3.3). Placeholder until the Documents module ships; owned by that module. */
export default async function ClientDocumentsTab(props: ClientTabProps) {
  void props;
  return <EmptyState message="This client's documents and requests will show here." />;
}
