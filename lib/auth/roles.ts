/**
 * Roles and their capabilities (§4.1). Pure and client-safe: the UI uses these to HIDE things,
 * but hiding is cosmetic (§0.1 rule 8). RLS and the server-side checks are the real control.
 */

export const APP_ROLES = ["partner", "manager", "employee", "client"] as const;
export type AppRole = (typeof APP_ROLES)[number];
export const STAFF_ROLES = ["partner", "manager", "employee"] as const satisfies readonly AppRole[];

export function isAppRole(v: unknown): v is AppRole {
  return typeof v === "string" && (APP_ROLES as readonly string[]).includes(v);
}

export const isStaff = (r: AppRole | null | undefined) => r === "partner" || r === "manager" || r === "employee";
export const isManagerOrPartner = (r: AppRole | null | undefined) => r === "partner" || r === "manager";
export const isPartner = (r: AppRole | null | undefined) => r === "partner";

export const ROLE_LABEL: Record<AppRole, string> = {
  partner: "Partner",
  manager: "Manager",
  employee: "Employee",
  client: "Client",
};

/** Where each role lands after sign-in (§4.4). */
export function homePathFor(role: AppRole): string {
  switch (role) {
    case "partner":
    case "manager":
      return "/dashboard";
    case "employee":
      return "/my-day";
    case "client":
      return "/portal";
  }
}

/**
 * Capabilities from the §4.1 table. Keep names stable: UI, server checks and tests import them.
 */
export const can = {
  manageFirmSettings: isPartner,
  managePartnersAndManagers: isPartner,
  manageEmployees: isManagerOrPartner,
  deleteTeamMember: isPartner,
  seeAllClients: isManagerOrPartner,
  editClients: isManagerOrPartner,
  deleteClient: isPartner,
  restoreFromRecycleBin: isManagerOrPartner,
  purgeFromRecycleBin: isPartner,
  seeMoney: isManagerOrPartner, // fees, invoices, receipts, credit notes, quotations, leads
  approveInvoices: isPartner,
  waiveInvoice: isPartner,
  issueCreditNote: isPartner,
  seePaymentsDashboard: isPartner,
  manageLeadsAndQuotations: isManagerOrPartner,
  createAndAssignTasks: isManagerOrPartner,
  fileTasks: isManagerOrPartner, // plus separation of duties, see lib/domain/transitions.ts
  seeFirmCalendar: isManagerOrPartner,
  manageCovers: isManagerOrPartner,
  grantVaultInCover: isPartner,
  manageWhatsAppSettings: isPartner,
  removeDesktopPc: isPartner,
  manageEngagementAndQuality: isManagerOrPartner,
  editPeerReview: isPartner,
  manageTemplates: isManagerOrPartner,
  managePeople: isManagerOrPartner,
  seeReports: isManagerOrPartner,
  seeAuditLog: isPartner,
  seeDiagnostics: isPartner,
} satisfies Record<string, (r: AppRole | null | undefined) => boolean>;

export type Capability = keyof typeof can;
