import type { ClientTabProps } from "@/components/client360/types";
import { EmptyState } from "@/components/app/empty-state";

/** Client 360 → Billing tab (§7.3.3). Placeholder until the Billing module ships; owned by that module. */
export default async function ClientBillingTab(props: ClientTabProps) {
  void props;
  return <EmptyState message="This client's invoices, receipts and statement of account will show here." />;
}
