import type { ClientTabProps } from "@/components/client360/types";
import { EmptyState } from "@/components/app/empty-state";

/** Client 360 → Registers tab (§7.3.3). Placeholder until the Registers module ships; owned by that module. */
export default async function ClientRegistersTab(props: ClientTabProps) {
  void props;
  return <EmptyState message="This client's portal credentials, registrations, DSCs, UDINs and filing history will show here." />;
}
