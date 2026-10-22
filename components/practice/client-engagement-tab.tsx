import type { ClientTabProps } from "@/components/client360/types";
import { EmptyState } from "@/components/app/empty-state";

/** Client 360 → Engagement tab (§7.3.3). Placeholder until the Engagement module ships; owned by that module. */
export default async function ClientEngagementTab(props: ClientTabProps) {
  void props;
  return <EmptyState message="This client's engagement letters and audit engagements will show here." />;
}
