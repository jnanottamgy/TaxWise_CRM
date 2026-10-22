/**
 * Navigation per role (§4.2), linked to the fixed routes of docs/CONVENTIONS.md §2.
 *
 * The sidebar renders `getNav(role)`; the command palette's "Go to" commands use `getGoToItems(role)`
 * (the sidebar plus a few destinations reached from inside a module); the "+ New" split button and the
 * palette's create commands use `getNewActions(role)`.
 *
 * Hiding a link is cosmetic (§0.1 rule 8): every page re-checks the role and RLS is the real control.
 * Pure and client-safe. Feature agents never edit this file (CONVENTIONS §2).
 */

import {
  ActivityIcon,
  BookOpenCheckIcon,
  Building2Icon,
  CalculatorIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  CalendarOffIcon,
  ChartLineIcon,
  CircleHelpIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  ClockIcon,
  FileChartColumnIcon,
  FileSignatureIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileWarningIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GaugeIcon,
  GitCompareArrowsIcon,
  Grid3x3Icon,
  HouseIcon,
  InboxIcon,
  LandmarkIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  ListChecksIcon,
  MessageCircleIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  ReceiptTextIcon,
  RepeatIcon,
  ScrollTextIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  StethoscopeIcon,
  SunIcon,
  TargetIcon,
  Trash2Icon,
  UserCheckIcon,
  UserRoundIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import type { AppRole } from "@/lib/auth/roles";

export interface NavItem {
  /** Stable key: favourites, tests and analytics refer to it. */
  id: string;
  label: string;
  href: string;
  /** Lucide outline icon, drawn at 16px in the sidebar. */
  icon: LucideIcon;
  /** Other path prefixes that also make this item the active one (e.g. /quotations under Leads). */
  match?: readonly string[];
  /** One plain sentence about what the page holds. The Help sheet shows it when a page has no guide. */
  description: string;
  /** Extra words the command palette matches on. */
  keywords?: readonly string[];
  /** Shows the unread Inbox count beside the label. */
  badge?: "inbox";
}

export interface NavGroup {
  id: string;
  /** Sentence-case group label; null renders a hairline instead. */
  label: string | null;
  items: NavItem[];
}

export type NewActionId = "client" | "task" | "invoice" | "quotation" | "lead" | "time";

export interface NewAction {
  id: NewActionId;
  label: string;
  href: string;
  icon: LucideIcon;
  keywords?: readonly string[];
}

// -------------------------------------------------------------------------------------------------
// Items (one definition each; the role lists below pick and relabel them)
// -------------------------------------------------------------------------------------------------

const I = {
  dashboard: {
    id: "dashboard",
    label: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboardIcon,
    description: "Today's decisions, deadlines, work in progress and collections at a glance.",
    keywords: ["home", "overview"],
  },
  inbox: {
    id: "inbox",
    label: "Inbox",
    href: "/inbox",
    icon: InboxIcon,
    description: "Approvals, review requests and updates addressed to you.",
    keywords: ["notifications", "approvals"],
    badge: "inbox",
  },
  clients: {
    id: "clients",
    label: "Clients",
    href: "/clients",
    icon: Building2Icon,
    description: "Every client with status, owner, services and the next deadline.",
    keywords: ["pan", "gstin", "customers"],
  },
  clientGroups: {
    id: "client-groups",
    label: "Client groups",
    href: "/clients/groups",
    icon: FolderTreeIcon,
    description: "Families and group companies managed and billed together.",
    keywords: ["family", "group companies"],
  },
  whatsappGroups: {
    id: "whatsapp-groups",
    label: "WhatsApp groups",
    href: "/whatsapp-groups",
    icon: MessageCircleIcon,
    description: "Each client's WhatsApp group, its members and when it was last opened.",
    keywords: ["whatsapp", "chat"],
  },
  work: {
    id: "work",
    label: "Work tracker",
    href: "/work",
    icon: ListChecksIcon,
    description: "Every task by status, owner and due date, as a table, board or calendar.",
    keywords: ["tasks", "jobs", "review"],
  },
  filings: {
    id: "filings",
    label: "Filings",
    href: "/filings",
    icon: Grid3x3Icon,
    description: "Clients against periods: who has filed each return, and who hasn't.",
    keywords: ["gstr-1", "gstr-3b", "tds return", "itr", "roc", "grid"],
  },
  calendar: {
    id: "calendar",
    label: "Calendar",
    href: "/calendar",
    icon: CalendarDaysIcon,
    description: "Statutory and firm deadlines by month, week or agenda.",
    keywords: ["due dates", "deadlines", "compliance"],
  },
  timesheet: {
    id: "timesheet",
    label: "Timesheet",
    href: "/timesheet",
    icon: ClockIcon,
    description: "Time logged against clients and tasks, by day and week.",
    keywords: ["time", "hours", "utilisation"],
  },
  gstRecon: {
    id: "gst-recon",
    label: "GST reconciliation",
    href: "/workpapers/gst-recon",
    icon: GitCompareArrowsIcon,
    description: "GSTR-2B and IMS against the purchase register, with ITC at risk.",
    keywords: ["gstr-2b", "ims", "itc", "purchase register", "workpapers"],
  },
  itr: {
    id: "itr",
    label: "ITR computation",
    href: "/workpapers/itr",
    icon: CalculatorIcon,
    description: "Income-tax computations for individuals and HUFs under both regimes.",
    keywords: ["income tax", "regime", "computation", "workpapers"],
  },
  financialStatements: {
    id: "financial-statements",
    label: "Financial statements",
    href: "/workpapers/financial-statements",
    icon: FileSpreadsheetIcon,
    description: "Schedule III balance sheet and profit and loss from the trial balance.",
    keywords: ["schedule iii", "balance sheet", "trial balance", "workpapers"],
  },
  notices: {
    id: "notices",
    label: "Notices",
    href: "/workpapers/notices",
    icon: FileWarningIcon,
    description: "Tax notices with reply due dates, hearings and demands.",
    keywords: ["litigation", "drc-01", "143(2)", "demand", "workpapers"],
  },
  leads: {
    id: "leads",
    label: "Leads & quotations",
    href: "/leads",
    icon: TargetIcon,
    match: ["/quotations", "/acceptance"],
    description: "Prospects, the quotations sent to them and what was accepted.",
    keywords: ["prospects", "proposals", "quotes", "sales"],
  },
  invoices: {
    id: "invoices",
    label: "Invoices",
    href: "/invoices",
    icon: ReceiptTextIcon,
    match: ["/tds-credits", "/retainer-drafts"],
    description: "What's outstanding, and what's overdue.",
    keywords: ["billing", "bills", "receipts", "credit notes"],
  },
  payments: {
    id: "payments",
    label: "Payments",
    href: "/payments",
    icon: WalletIcon,
    description: "Receivables, ageing and collections across the firm.",
    keywords: ["receivables", "ageing", "collections", "debtors"],
  },
  feeRealisation: {
    id: "fee-realisation",
    label: "Fee realisation",
    href: "/fee-realisation",
    icon: GaugeIcon,
    description: "Fees billed against the value of the time spent, by client and service.",
    keywords: ["realisation", "write-off"],
  },
  revenue: {
    id: "revenue",
    label: "Revenue",
    href: "/revenue",
    icon: ChartLineIcon,
    description: "Revenue by month, service and partner.",
    keywords: ["income", "turnover"],
  },
  people: {
    id: "people",
    label: "People",
    href: "/people",
    icon: UsersIcon,
    description: "The team: roles, logins, clients and capacity.",
    keywords: ["team", "staff", "employees"],
  },
  performance: {
    id: "performance",
    label: "Performance & attendance",
    href: "/performance",
    icon: ActivityIcon,
    description: "Attendance, utilisation and work completed per person.",
    keywords: ["attendance", "utilisation", "capacity"],
  },
  leave: {
    id: "leave",
    label: "Leave",
    href: "/leave",
    icon: CalendarOffIcon,
    description: "Leave requests, approvals and who is away.",
    keywords: ["holiday", "absence", "time off"],
  },
  registers: {
    id: "registers",
    label: "Registers",
    href: "/registers",
    icon: LibraryIcon,
    description: "Portal credentials, registrations, DSCs, UDINs and filing history.",
    keywords: ["vault", "dsc", "udin", "registrations"],
  },
  engagementLetters: {
    id: "engagement-letters",
    label: "Engagement letters",
    href: "/engagement-letters",
    icon: FileSignatureIcon,
    description: "Engagement letters issued, signed and due for renewal.",
    keywords: ["engagement", "terms"],
  },
  quality: {
    id: "quality",
    label: "Quality",
    href: "/quality",
    icon: ShieldCheckIcon,
    match: ["/audits"],
    description: "Peer review, client acceptance, KYC, independence and retention.",
    keywords: ["peer review", "acceptance", "retention", "kyc", "sqc"],
  },
  jobTemplates: {
    id: "job-templates",
    label: "Job templates",
    href: "/templates/jobs",
    icon: ClipboardListIcon,
    description: "Standard checklists and recurring jobs used to create tasks.",
    keywords: ["checklists", "recurring"],
  },
  messageTemplates: {
    id: "message-templates",
    label: "Message templates",
    href: "/templates/messages",
    icon: MessageSquareTextIcon,
    description: "Email and WhatsApp wording for reminders and updates.",
    keywords: ["email", "whatsapp", "reminders"],
  },
  reports: {
    id: "reports",
    label: "Reports",
    href: "/reports",
    icon: FileChartColumnIcon,
    description: "Firm reports on work, compliance, billing and people.",
    keywords: ["export", "analysis"],
  },
  auditLog: {
    id: "audit-log",
    label: "Audit log",
    href: "/audit-log",
    icon: ScrollTextIcon,
    description: "Every sign-in, change and export, with who did it and when.",
    keywords: ["history", "trail", "security"],
  },
  recycleBin: {
    id: "recycle-bin",
    label: "Recycle bin",
    href: "/recycle-bin",
    icon: Trash2Icon,
    description: "Deleted clients, tasks, invoices and documents, ready to restore.",
    keywords: ["deleted", "restore", "trash"],
  },
  firmSettings: {
    id: "settings",
    label: "Settings",
    href: "/settings/firm",
    icon: SettingsIcon,
    match: ["/settings"],
    description: "Firm details, bank and UPI, numbering, billing, working hours and integrations.",
    keywords: ["configuration", "firm"],
  },
  myDay: {
    id: "my-day",
    label: "My day",
    href: "/my-day",
    icon: SunIcon,
    description: "What to do next: today's tasks, deadlines and your timer.",
    keywords: ["today", "home"],
  },
  messages: {
    id: "messages",
    label: "Messages",
    href: "/messages",
    icon: MessagesSquareIcon,
    description: "Conversations with clients across email, portal and WhatsApp hand-offs.",
    keywords: ["email", "portal", "chat"],
  },
  profile: {
    id: "profile",
    label: "Profile",
    href: "/profile",
    icon: UserRoundIcon,
    description: "Your name, phone, theme, notifications and password.",
    keywords: ["account", "password", "notifications"],
  },
  search: {
    id: "search",
    label: "Search",
    href: "/search",
    icon: SearchIcon,
    description: "Search across clients, contacts, tasks, documents and people.",
    keywords: ["find"],
  },
  // Reached from inside a module; in the palette's "Go to" list but not in the sidebar.
  quotations: {
    id: "quotations",
    label: "Quotations",
    href: "/quotations",
    icon: FileTextIcon,
    description: "Quotations in draft, waiting for approval, sent and answered.",
    keywords: ["quotes", "proposals"],
  },
  acceptance: {
    id: "acceptance",
    label: "Client acceptance",
    href: "/acceptance",
    icon: UserCheckIcon,
    description: "Conflict checks and acceptance decisions before taking on a client.",
    keywords: ["conflict check", "kyc"],
  },
  tdsCredits: {
    id: "tds-credits",
    label: "TDS credits",
    href: "/tds-credits",
    icon: LandmarkIcon,
    description: "TDS deducted by clients on the firm's fees, matched against Form 26AS.",
    keywords: ["26as", "tds"],
  },
  retainerDrafts: {
    id: "retainer-drafts",
    label: "Retainer drafts",
    href: "/retainer-drafts",
    icon: RepeatIcon,
    description: "Retainer invoices drafted by the monthly billing run, waiting to be issued.",
    keywords: ["recurring", "auto billing"],
  },
  audits: {
    id: "audits",
    label: "Audit engagements",
    href: "/audits",
    icon: BookOpenCheckIcon,
    description: "Statutory, tax and other audits run to the Standards on Auditing.",
    keywords: ["statutory audit", "tax audit", "sa"],
  },
  diagnostics: {
    id: "diagnostics",
    label: "Diagnostics",
    href: "/settings/diagnostics",
    icon: StethoscopeIcon,
    description: "Database, schema version, email, storage and job health.",
    keywords: ["health", "status", "schema"],
  },
} as const satisfies Record<string, NavItem>;

/** Firm settings sections (CONVENTIONS §2), Partner only. Diagnostics is listed separately. */
const SETTINGS_SECTIONS: Array<{ slug: string; label: string; keywords?: string[] }> = [
  { slug: "firm", label: "Firm details", keywords: ["gstin", "pan", "frn", "logo", "address"] },
  { slug: "bank", label: "Bank & UPI", keywords: ["upi", "ifsc", "account"] },
  { slug: "numbering", label: "Numbering", keywords: ["invoice number", "prefix", "series"] },
  { slug: "billing", label: "Billing", keywords: ["sac", "gst rate", "approval limit", "payment terms"] },
  { slug: "working-hours", label: "Working hours", keywords: ["holidays", "late", "capacity"] },
  { slug: "reminders", label: "Reminders", keywords: ["digest", "lead days"] },
  { slug: "email", label: "Email", keywords: ["domain", "resend", "dns"] },
  { slug: "whatsapp", label: "WhatsApp", keywords: ["numbers", "client mode", "linked pcs", "house rules"] },
  { slug: "law", label: "Law & rules", keywords: ["statutory parameters", "due dates", "extensions"] },
  { slug: "templates", label: "Templates", keywords: ["job templates", "message templates"] },
  { slug: "data", label: "Data", keywords: ["export", "privacy notice"] },
];

// -------------------------------------------------------------------------------------------------
// Role lists (§4.2)
// -------------------------------------------------------------------------------------------------

function partnerNav(): NavGroup[] {
  return [
    { id: "home", label: "Home", items: [I.dashboard, I.inbox] },
    { id: "clients", label: "Clients", items: [I.clients, I.clientGroups, I.whatsappGroups] },
    { id: "work", label: "Work", items: [I.work, I.filings, I.calendar, I.timesheet] },
    { id: "workpapers", label: "Workpapers", items: [I.gstRecon, I.itr, I.financialStatements, I.notices] },
    { id: "growth", label: "Growth", items: [I.leads] },
    { id: "money", label: "Money", items: [I.invoices, I.payments, I.feeRealisation, I.revenue] },
    { id: "team", label: "Team", items: [I.people, I.performance, I.leave] },
    {
      id: "practice",
      label: "Practice",
      items: [I.registers, I.engagementLetters, I.quality, I.jobTemplates, I.messageTemplates],
    },
    { id: "admin", label: "Admin", items: [I.reports, I.auditLog, I.recycleBin, I.firmSettings] },
  ];
}

/** §4.2: the Partner's list minus Payments, Audit log, Diagnostics and firm-level Settings. */
function managerNav(): NavGroup[] {
  const managerSettings: NavItem = {
    ...I.profile,
    id: "settings",
    label: "Settings",
    // "Their Settings is just their profile."
    description: "Your profile: name, phone, theme, notifications and password.",
    keywords: ["profile", "account", "password", "notifications"],
  };
  return partnerNav().map((group) => {
    if (group.id === "money") return { ...group, items: group.items.filter((i) => i.id !== "payments") };
    if (group.id === "admin") return { ...group, items: [I.reports, I.recycleBin, managerSettings] };
    return group;
  });
}

/** §4.2: My day · My tasks · My clients · My timesheet · Calendar · Workpapers (4) · Messages · Leave · Profile. */
function employeeNav(): NavGroup[] {
  return [
    {
      id: "mine",
      label: null,
      items: [
        I.myDay,
        { ...I.work, label: "My tasks", description: "Tasks assigned to you, or waiting for your review." },
        {
          ...I.clients,
          label: "My clients",
          description: "Clients you own, work on, or are covering for a colleague.",
        },
        { ...I.timesheet, label: "My timesheet", description: "Your week of logged time against the weekly target." },
        { ...I.calendar, description: "Deadlines for your clients by month, week or agenda." },
      ],
    },
    { id: "workpapers", label: "Workpapers", items: [I.gstRecon, I.itr, I.financialStatements, I.notices] },
    {
      id: "you",
      label: null,
      items: [I.messages, { ...I.leave, description: "Your leave requests and balance." }, I.profile],
    },
  ];
}

/** §4.2 client portal: Home · Deadlines · Compliance · Documents · Invoices · Messages · Help. */
export const PORTAL_NAV: readonly NavItem[] = [
  {
    id: "portal-home",
    label: "Home",
    href: "/portal",
    icon: HouseIcon,
    description: "Your next deadlines, the documents we need and invoices due.",
  },
  {
    id: "portal-deadlines",
    label: "Deadlines",
    href: "/portal/deadlines",
    icon: CalendarClockIcon,
    description: "Upcoming and overdue filings, explained in plain language.",
  },
  {
    id: "portal-compliance",
    label: "Compliance",
    href: "/portal/compliance",
    icon: ClipboardCheckIcon,
    description: "Filing status by period, with acknowledgement numbers.",
  },
  {
    id: "portal-documents",
    label: "Documents",
    href: "/portal/documents",
    icon: FolderOpenIcon,
    description: "Documents we have asked you for, and documents we have shared with you.",
  },
  {
    id: "portal-invoices",
    label: "Invoices",
    href: "/portal/invoices",
    icon: ReceiptTextIcon,
    description: "Your invoices, receipts and how to pay.",
  },
  {
    id: "portal-messages",
    label: "Messages",
    href: "/portal/messages",
    icon: MessagesSquareIcon,
    description: "Your conversation with the firm.",
  },
  {
    id: "portal-help",
    label: "Help",
    href: "/portal/help",
    icon: CircleHelpIcon,
    description: "Answers to common questions, and how to reach us.",
  },
];

/** The sidebar for a role (§4.2). A Client gets the portal's top navigation as one group. */
export function getNav(role: AppRole): NavGroup[] {
  switch (role) {
    case "partner":
      return partnerNav();
    case "manager":
      return managerNav();
    case "employee":
      return employeeNav();
    case "client":
      return [{ id: "portal", label: null, items: [...PORTAL_NAV] }];
  }
}

function extraDestinations(role: AppRole): NavItem[] {
  switch (role) {
    case "partner":
      return [
        I.messages,
        I.quotations,
        I.acceptance,
        I.tdsCredits,
        I.retainerDrafts,
        I.audits,
        I.search,
        I.profile,
        ...SETTINGS_SECTIONS.map(
          (s): NavItem => ({
            id: `settings-${s.slug}`,
            label: `Settings: ${s.label}`,
            href: `/settings/${s.slug}`,
            icon: SettingsIcon,
            description: `Firm settings: ${s.label.toLowerCase()}.`,
            keywords: ["settings", ...(s.keywords ?? [])],
          }),
        ),
        I.diagnostics,
      ];
    case "manager":
      return [I.messages, I.quotations, I.acceptance, I.tdsCredits, I.retainerDrafts, I.audits, I.search];
    case "employee":
      return [I.inbox, I.search];
    case "client":
      return [];
  }
}

/**
 * Every destination the command palette offers as "Go to …" for a role: the sidebar items, then
 * pages reached from inside a module. Unique by href.
 */
export function getGoToItems(role: AppRole): NavItem[] {
  const seen = new Set<string>();
  const out: NavItem[] = [];
  for (const item of [...getNav(role).flatMap((g) => g.items), ...extraDestinations(role)]) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    out.push(item);
  }
  return out;
}

/**
 * The "+ New" items a role may use (§3.3), in menu order. Pages open their create form when they see
 * `?new=1` (the routes are fixed, so there is no /work/new).
 */
export function getNewActions(role: AppRole): NewAction[] {
  const managerOrPartner = role === "partner" || role === "manager";
  const staff = role !== "client";
  const all: Array<[allowed: boolean, action: NewAction]> = [
    [managerOrPartner, { id: "client", label: "New client", href: "/clients/new", icon: Building2Icon, keywords: ["add client", "onboard"] }],
    [managerOrPartner, { id: "task", label: "New task", href: "/work?new=1", icon: ListChecksIcon, keywords: ["add task", "assign"] }],
    [managerOrPartner, { id: "invoice", label: "New invoice", href: "/invoices/new", icon: ReceiptTextIcon, keywords: ["bill", "raise invoice"] }],
    [managerOrPartner, { id: "quotation", label: "New quotation", href: "/quotations/new", icon: FileTextIcon, keywords: ["quote", "proposal"] }],
    [managerOrPartner, { id: "lead", label: "New lead", href: "/leads?new=1", icon: TargetIcon, keywords: ["prospect", "enquiry"] }],
    [staff, { id: "time", label: "Log time", href: "/timesheet?new=1", icon: ClockIcon, keywords: ["timesheet", "hours"] }],
  ];
  return all.filter(([allowed]) => allowed).map(([, action]) => action);
}

/** The split button's main action: the one each role reaches for most (§3.3). */
export function defaultNewAction(role: AppRole): NewAction | null {
  const actions = getNewActions(role);
  return actions.find((a) => a.id === "task") ?? actions[0] ?? null;
}

// -------------------------------------------------------------------------------------------------
// Matching the current path
// -------------------------------------------------------------------------------------------------

function pathOf(href: string): string {
  return href.split(/[?#]/)[0];
}

function prefixLength(pathname: string, base: string): number {
  if (pathname === base) return base.length + 1; // an exact hit beats a prefix of the same length
  return pathname.startsWith(`${base}/`) ? base.length : -1;
}

/** How strongly `pathname` matches an item: -1 for no match, longer prefixes win. */
export function navMatchScore(pathname: string, item: Pick<NavItem, "href" | "match">): number {
  let best = prefixLength(pathname, pathOf(item.href));
  for (const m of item.match ?? []) best = Math.max(best, prefixLength(pathname, m));
  return best;
}

export interface ActiveNav {
  item: NavItem;
  /** The sidebar group it sits in, or null for a destination outside the sidebar. */
  group: NavGroup | null;
  /**
   * For a destination outside the sidebar, the sidebar item it lives under, if any
   * (/settings/diagnostics: "Diagnostics" under "Settings" in "Admin").
   */
  parent: { item: NavItem; group: NavGroup } | null;
}

/**
 * The item for the page being shown: the longest matching prefix, so /clients/groups is "Client
 * groups", not "Clients". Sidebar items win ties over the palette's extra destinations.
 */
export function findActiveNav(pathname: string, role: AppRole): ActiveNav | null {
  let sidebar: { item: NavItem; group: NavGroup } | null = null;
  let sidebarScore = -1;
  for (const group of getNav(role)) {
    for (const item of group.items) {
      const score = navMatchScore(pathname, item);
      if (score > sidebarScore) {
        sidebar = { item, group };
        sidebarScore = score;
      }
    }
  }
  let extra: NavItem | null = null;
  let extraScore = -1;
  for (const item of extraDestinations(role)) {
    const score = navMatchScore(pathname, item);
    if (score > extraScore) {
      extra = item;
      extraScore = score;
    }
  }
  if (extra && extraScore > sidebarScore) return { item: extra, group: null, parent: sidebar };
  return sidebar ? { item: sidebar.item, group: sidebar.group, parent: null } : null;
}

/** True when `href` is one of the role's sidebar items (only those can be starred as favourites). */
export function isNavHref(role: AppRole, href: string): boolean {
  return getNav(role).some((g) => g.items.some((i) => i.href === href));
}

/** The sidebar item for an href, if any. */
export function navItemByHref(role: AppRole, href: string): NavItem | null {
  for (const g of getNav(role)) for (const i of g.items) if (i.href === href) return i;
  return null;
}
