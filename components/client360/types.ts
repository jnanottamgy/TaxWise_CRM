import type { CurrentUser } from "@/lib/auth/current-user";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Props every Client 360 tab receives (§7.3.3). Tabs are async Server Components owned by their
 * module (tasks, compliance, documents, billing, …); the Client 360 page only lays them out.
 * A tab must never throw: catch its own loads and render ErrorBlock with the Ref.
 */
export interface ClientTabProps {
  clientId: string;
  user: CurrentUser;
  supabase: ServerSupabase;
  /** The page's search params, for tabs with their own filters/pagination (prefix your keys). */
  searchParams: Record<string, string | string[] | undefined>;
}
