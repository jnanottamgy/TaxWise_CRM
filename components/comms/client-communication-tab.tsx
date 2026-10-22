import type { ClientTabProps } from "@/components/client360/types";
import { EmptyState } from "@/components/app/empty-state";

/** Client 360 → Communication tab (§7.3.3). Placeholder until the Communication module ships; owned by that module. */
export default async function ClientCommunicationTab(props: ClientTabProps) {
  void props;
  return <EmptyState message="Every message with this client will show here." />;
}
