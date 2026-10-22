import type { ClientTabProps } from "@/components/client360/types";
import { EmptyState } from "@/components/app/empty-state";

/** Client 360 → WhatsApp group tab (§7.3.3). Placeholder until the WhatsApp group module ships; owned by that module. */
export default async function ClientWhatsAppTab(props: ClientTabProps) {
  void props;
  return <EmptyState message="This client's WhatsApp group register will show here." />;
}
