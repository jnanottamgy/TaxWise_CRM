import type { ClientTabProps } from "@/components/client360/types";
import { EmptyState } from "@/components/app/empty-state";

/** Client 360 → Workpapers tab (§7.3.3). Placeholder until the Workpapers module ships; owned by that module. */
export default async function ClientWorkpapersTab(props: ClientTabProps) {
  void props;
  return <EmptyState message="This client's GST reconciliations, ITR computations, financial statements and notices will show here." />;
}
