import { z } from "zod";

/**
 * Client groups (§7.4): families and group companies managed together. Name* (unique, case does
 * not matter), notes, member clients. Invoicing stays per client. Client-safe.
 */

export const GROUP_MEMBERS_MAX = 200;

export const ClientGroupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { error: "Name the group (at least 2 characters)." })
    .max(80, { error: "Keep the name under 80 characters." }),
  notes: z
    .string()
    .trim()
    .max(2000, { error: "Keep the notes under 2,000 characters." })
    .default(""),
});
export type ClientGroupValues = z.input<typeof ClientGroupSchema>;

export const CreateClientGroupSchema = ClientGroupSchema.extend({
  /** Clients to add straight away (optional). */
  clientIds: z.array(z.uuid()).max(GROUP_MEMBERS_MAX).default([]),
});
export type CreateClientGroupInput = z.input<typeof CreateClientGroupSchema>;

export const UpdateClientGroupSchema = ClientGroupSchema.extend({
  id: z.uuid({ error: "That group isn't valid." }),
  /** The row's updated_at when the form opened (§13 optimistic concurrency). */
  updatedAt: z.string().min(1),
});
export type UpdateClientGroupInput = z.input<typeof UpdateClientGroupSchema>;

export const DeleteClientGroupSchema = z.object({
  id: z.uuid({ error: "That group isn't valid." }),
  updatedAt: z.string().min(1),
});

export const GroupMembersSchema = z.object({
  groupId: z.uuid({ error: "That group isn't valid." }),
  clientIds: z
    .array(z.uuid({ error: "That client isn't valid." }))
    .min(1, { error: "Choose at least one client." })
    .max(GROUP_MEMBERS_MAX, { error: `Add at most ${GROUP_MEMBERS_MAX} clients at a time.` })
    .transform((ids) => [...new Set(ids)]),
});
export type GroupMembersInput = z.input<typeof GroupMembersSchema>;

export const GROUP_SORTABLE = ["name", "members", "open_tasks", "next_due_date", "outstanding", "updated_at"] as const;
export type GroupSort = (typeof GROUP_SORTABLE)[number];

/** "Moves 2 clients out of Sharma family" etc. A client already in another group moves (one group per client, §5.3). */
export function moveWarning(moving: ReadonlyArray<{ display_name: string; group_name: string | null }>, groupName: string): string | null {
  const elsewhere = moving.filter((m) => m.group_name && m.group_name !== groupName);
  if (elsewhere.length === 0) return null;
  if (elsewhere.length === 1) return `${elsewhere[0].display_name} moves from ${elsewhere[0].group_name} to ${groupName}: a client is in one group at a time.`;
  return `${elsewhere.length} of these clients move from their current group to ${groupName}: a client is in one group at a time.`;
}
