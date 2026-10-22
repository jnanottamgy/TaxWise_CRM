import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * For deliberately generic probes whose table or function name is chosen at run time
 * (diagnostics, number-series collision checks). Everything else uses the typed client.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UntypedSupabase = SupabaseClient<any, "public", any>;

export function untyped(client: unknown): UntypedSupabase {
  return client as UntypedSupabase;
}
