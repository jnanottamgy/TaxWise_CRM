import type { TeamRole } from "@/lib/domain/enums";

/**
 * The owner and engagement team as one comparable string (§13 optimistic concurrency on the Team
 * form). Mirror of client_team_signature() in 0115: "owner:<id>;" then "role:id" pairs sorted by
 * role, then id, in code-unit (C collation) order, joined by commas. Pure and client-safe.
 */
export function teamSignature(ownerEmployeeId: string | null, members: ReadonlyArray<{ employee_id: string; team_role: TeamRole | string }>): string {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const pairs = members
    .map((m) => ({ role: String(m.team_role), id: m.employee_id }))
    .sort((a, b) => cmp(a.role, b.role) || cmp(a.id, b.id))
    .map((m) => `${m.role}:${m.id}`);
  return `owner:${ownerEmployeeId ?? ""};${pairs.join(",")}`;
}

export interface TeamPick {
  owner: string | null;
  engagementPartner: string | null;
  reviewManager: string | null;
  preparers: string[];
}

/** The team form's starting values from the stored rows (one engagement partner and one review manager, §7.3.3). */
export function teamPickFrom(ownerEmployeeId: string | null, members: ReadonlyArray<{ employee_id: string; team_role: TeamRole | string }>): TeamPick {
  return {
    owner: ownerEmployeeId,
    engagementPartner: members.find((m) => m.team_role === "engagement_partner")?.employee_id ?? null,
    reviewManager: members.find((m) => m.team_role === "review_manager")?.employee_id ?? null,
    preparers: members.filter((m) => m.team_role === "preparer").map((m) => m.employee_id),
  };
}

/** "Anita Rao joined as preparer; Ravi Kumar left as review manager; owner changed to …" for the timeline. */
export function describeTeamChange(
  diff: { added: ReadonlyArray<{ employee_id: string; team_role: string }>; removed: ReadonlyArray<{ employee_id: string; team_role: string }>; ownerChanged: boolean; owner: string | null },
  nameOf: (employeeId: string) => string,
  roleLabel: (role: string) => string,
): string[] {
  const lines: string[] = [];
  if (diff.ownerChanged && diff.owner) lines.push(`${nameOf(diff.owner)} is now the client owner`);
  for (const a of diff.added) lines.push(`${nameOf(a.employee_id)} added as ${roleLabel(a.team_role).toLowerCase()}`);
  for (const r of diff.removed) lines.push(`${nameOf(r.employee_id)} removed as ${roleLabel(r.team_role).toLowerCase()}`);
  return lines;
}
