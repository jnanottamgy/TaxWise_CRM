import type { ClientTabProps } from "@/components/client360/types";
import { EmptyState } from "@/components/app/empty-state";

/** Client 360 → Compliance tab (§7.3.3). Placeholder until the Compliance module ships; owned by that module. */
export default async function ClientComplianceTab(props: ClientTabProps) {
  void props;
  return <EmptyState message="This client's compliance calendar will show here." />;
}
