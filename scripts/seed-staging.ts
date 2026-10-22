/**
 * Synthetic data for a STAGING database, never production (§16: "Staging gets synthetic data from a
 * separate script that refuses to run when APP_ENV=production"; §12: production data never goes
 * to staging, and staging is seeded with synthetic data only; §0.1 rule 14).
 *
 *   STAGING_DATABASE_URL=postgres://… npx tsx scripts/seed-staging.ts [options]
 *
 *   --clients <n>        how many synthetic clients (default 36, at most 200)
 *   --seed <n>           seed for the generator, so a run can be repeated exactly (default 2026)
 *   --today <date>       treat this YYYY-MM-DD as today in IST (default: today in IST)
 *   --dry-run            write everything inside a transaction, print the counts, then roll back
 *
 * It creates a believable Bengaluru CA practice: staff records (no logins), client groups, clients
 * of every entity type with valid-checksum GSTINs and well-formed PAN/TAN, contacts, services with
 * fees, team members, the statutory calendar and prep steps from the app's own engine
 * (lib/domain/statutory-calendar.ts, reading the due_date_rules and overrides in the database),
 * tasks with checklists from the job templates, filing records, invoices (from the locked counter,
 * with GST worked out by lib/domain/gst.ts) and receipts with TDS (lib/domain/tds.ts).
 *
 * It refuses to run:
 *   - when APP_ENV=production;
 *   - without STAGING_DATABASE_URL (a postgres:// URL); it never reads DATABASE_URL or DIRECT_URL;
 *   - against any host other than this machine (localhost, 127.0.0.1, ::1) unless SEED_TARGET=staging;
 *   - when the database isn't migrated, or hasn't had the production seed (supabase/seed/*.sql);
 *   - when the database holds any client this script didn't create: it fills an empty staging
 *     database and never mixes with real data. If its own data is already there, it does nothing.
 *
 * It creates no auth users and holds no passwords or keys. Everything it writes is marked: clients
 * carry the note below, and every email address is on example.com (reserved by RFC 2606). PANs,
 * GSTINs and TANs are random and may coincide with real ones; phone numbers are synthetic
 * (+91 90000 xxxxx) and may belong to real people, so never press Send on a WhatsApp hand-off from
 * staging. Never use any of it for a filing.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { EntityType, ServiceFrequency, ServiceType, TaskPriority, TaskStatus } from "@/lib/domain/enums";
import {
  addDays,
  addMonths,
  compareDates,
  diffDays,
  financialYearOf,
  isDateString,
  MONTH_ABBR,
  parseDateString,
  previousFinancialYear,
  quarterLabel,
  quarterOf,
  todayIST,
  toDateString,
  type DateString,
} from "@/lib/domain/fy";
import { GST_DEFAULTS, invoiceTotals, reimbursementDescription, sacFor, type SacMap } from "@/lib/domain/gst";
import { gstinCheckCharacter, validateGstin, validatePan, validateTan } from "@/lib/domain/india-validators";
import { paiseToDecimalString, percentOf, toPaise, type Paise } from "@/lib/domain/money";
import {
  DUE_DATE_OVERRIDE_SEED,
  DUE_DATE_RULE_SEED,
  generateEvents,
  generateOpsEvents,
  OPS_TEMPLATE_DEFAULTS,
  parseDueDateOverrideRow,
  parseDueDateRuleRow,
  toComplianceEventInsert,
  type CalendarClientProfile,
  type CalendarEvent,
  type DueDateOverride,
  type DueDateOverrideRow,
  type DueDateRule,
  type DueDateRuleRow,
  type OpsTemplate,
} from "@/lib/domain/statutory-calendar";
import { tdsRuleFor } from "@/lib/domain/tds";

// =================================================================================================
// Safety: where the script may write (§16, §12)
// =================================================================================================

/** Hosts that mean "this machine". */
export const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/** The note on every synthetic client: how the script recognises its own data. */
export const SYNTHETIC_MARKER = "Synthetic staging data (scripts/seed-staging.ts). Not a real client.";

/** The domain of every synthetic email address (RFC 2606: reserved, never delivered). */
export const SYNTHETIC_EMAIL_DOMAIN = "example.com";

export const STAGING_DEFAULTS = { clients: 36, maxClients: 200, seed: 2026 } as const;

export type TargetCheck = { ok: true; url: string; host: string; database: string } | { ok: false; reason: string };

/**
 * Decides whether the script may write to `STAGING_DATABASE_URL` (§16, §12). Refuses with
 * `APP_ENV=production`; without a `postgres://` URL; and for any host other than this machine unless
 * `SEED_TARGET=staging` says the remote database is a staging one.
 */
export function checkTarget(env: Readonly<Record<string, string | undefined>>): TargetCheck {
  if ((env.APP_ENV ?? "").trim().toLowerCase() === "production") {
    return { ok: false, reason: "Refusing to run with APP_ENV=production. Synthetic data never goes near production (§16)." };
  }
  const raw = (env.STAGING_DATABASE_URL ?? "").trim();
  if (raw === "") {
    return { ok: false, reason: "Set STAGING_DATABASE_URL to the staging database (postgres://…). DATABASE_URL is never used." };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "STAGING_DATABASE_URL isn't a valid URL. Expected postgres://user:password@host:5432/database." };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return { ok: false, reason: `STAGING_DATABASE_URL must start with postgres:// or postgresql://, not ${url.protocol}//.` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "") return { ok: false, reason: "STAGING_DATABASE_URL has no host." };
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database === "") return { ok: false, reason: "STAGING_DATABASE_URL has no database name." };
  const local = LOCAL_HOSTS.includes(host);
  if (!local && (env.SEED_TARGET ?? "").trim() !== "staging") {
    return {
      ok: false,
      reason: `Refusing to write to ${host}: it isn't this machine. If it is a staging database, set SEED_TARGET=staging as well.`,
    };
  }
  return { ok: true, url: raw, host, database };
}

// =================================================================================================
// A small seeded generator, so a run can be repeated exactly
// =================================================================================================

export type Random = {
  /** A number in [0, 1). */
  next(): number;
  /** A whole number from `min` to `max`, both included. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
};

/** mulberry32: small, fast and good enough for synthetic data. */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError("Nothing to pick from.");
      return items[int(0, items.length - 1)];
    },
    chance: (probability: number): boolean => next() < probability,
  };
}

// =================================================================================================
// Synthetic identifiers (formats and checks from §6.2, via lib/domain/india-validators.ts)
// =================================================================================================

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function letter(rand: Random): string {
  return LETTERS[rand.int(0, 25)];
}

function digits(rand: Random, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += String(rand.int(0, 9));
  return out;
}

/** A well-formed PAN (§6.2): 3 letters, the holder type, the name's initial, 4 digits, a letter. */
export function syntheticPan(rand: Random, holderType: string, nameInitial: string): string {
  const initial = /^[A-Z]$/.test(nameInitial) ? nameInitial : "X";
  return `${letter(rand)}${letter(rand)}${letter(rand)}${holderType}${initial}${digits(rand, 4)}${letter(rand)}`;
}

/** A GSTIN that passes the mod-36 check (§6.2): state code, PAN, entity number, `Z`, check character. */
export function syntheticGstin(stateCode: string, pan: string, entityNumber = "1"): string {
  const first14 = `${stateCode}${pan}${entityNumber}Z`;
  const check = gstinCheckCharacter(first14);
  if (check === null) throw new RangeError(`Can't build a GSTIN from ${first14}.`);
  return `${first14}${check}`;
}

/** A well-formed Bengaluru TAN (§6.2): `BLR`, the name's initial, 5 digits, a letter. */
export function syntheticTan(rand: Random, nameInitial: string): string {
  const initial = /^[A-Z]$/.test(nameInitial) ? nameInitial : "X";
  return `BLR${initial}${digits(rand, 5)}${letter(rand)}`;
}

/** A synthetic Indian mobile, `+91 90000 12345`: the block 90000 xxxxx, numbered by `serial`. */
export function syntheticMobile(serial: number): string {
  const subscriber = `90000${String(serial % 100000).padStart(5, "0")}`;
  return `+91 ${subscriber.slice(0, 5)} ${subscriber.slice(5)}`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// =================================================================================================
// The practice: catalogues of believable Bengaluru names and places
// =================================================================================================

const AREAS: ReadonlyArray<{ name: string; pincode: string }> = [
  { name: "Malleshwaram", pincode: "560003" },
  { name: "Jayanagar", pincode: "560041" },
  { name: "Basavanagudi", pincode: "560004" },
  { name: "Indiranagar", pincode: "560038" },
  { name: "Koramangala", pincode: "560034" },
  { name: "Rajajinagar", pincode: "560010" },
  { name: "Yeshwanthpur", pincode: "560022" },
  { name: "Peenya", pincode: "560058" },
  { name: "Whitefield", pincode: "560066" },
  { name: "Hebbal", pincode: "560024" },
  { name: "Banashankari", pincode: "560050" },
  { name: "Vijayanagar", pincode: "560040" },
  { name: "Sadashivanagar", pincode: "560080" },
  { name: "Frazer Town", pincode: "560005" },
  { name: "HSR Layout", pincode: "560102" },
  { name: "Electronic City", pincode: "560100" },
  { name: "JP Nagar", pincode: "560078" },
  { name: "RT Nagar", pincode: "560032" },
  { name: "Chickpet", pincode: "560053" },
  { name: "Ulsoor", pincode: "560008" },
  { name: "Domlur", pincode: "560071" },
  { name: "Marathahalli", pincode: "560037" },
  { name: "Yelahanka", pincode: "560064" },
  { name: "BTM Layout", pincode: "560076" },
];

/** A few clients sit in other states, so invoices show IGST as well as CGST + SGST (§6.4). */
const OTHER_STATES: ReadonlyArray<{ stateCode: string; city: string; pincode: string; area: string }> = [
  { stateCode: "33", city: "Chennai", pincode: "600017", area: "T Nagar" },
  { stateCode: "27", city: "Mumbai", pincode: "400069", area: "Andheri East" },
  { stateCode: "36", city: "Hyderabad", pincode: "500081", area: "Madhapur" },
  { stateCode: "32", city: "Kochi", pincode: "682016", area: "MG Road" },
];

const STREETS = ["1st Main Road", "2nd Cross", "4th Main", "8th Cross", "11th Main", "Service Road", "Temple Street", "Market Road", "Industrial Layout", "100 Feet Road"];

const FIRST_NAMES = [
  "Ramesh", "Suresh", "Prakash", "Anand", "Vinod", "Mahesh", "Naveen", "Raghu", "Srinivas", "Manjunath",
  "Kavitha", "Lakshmi", "Shwetha", "Deepa", "Ananya", "Priya", "Meera", "Sowmya", "Rashmi", "Vidya",
  "Arun", "Kiran", "Harish", "Girish", "Sunil", "Shilpa", "Divya", "Pavan", "Chetan", "Nandini",
];
const SURNAMES = [
  "Rao", "Gowda", "Hegde", "Shetty", "Kulkarni", "Iyer", "Nair", "Reddy", "Murthy", "Bhat",
  "Kamath", "Shenoy", "Patil", "Prasad", "Naidu", "Joshi", "Pai", "Acharya", "Desai", "Menon",
];
const DEITIES = ["Lakshmi", "Venkateshwara", "Ganesh", "Manjunatha", "Raghavendra", "Durga", "Chamundeshwari", "Annapoorna", "Saraswathi", "Basaveshwara"];

const TRADES: Readonly<Record<"company" | "llp" | "partnership" | "proprietorship", readonly string[]>> = {
  company: ["Textiles", "Precision Tools", "Agro Foods", "Software Labs", "Cloud Systems", "Packaging", "Auto Components", "Pharma", "Logistics", "Electricals", "Interiors", "Constructions", "Engineering Works", "Polymers", "Infotech", "Foods"],
  llp: ["Architects", "Realty", "Consulting", "Organic Farms", "Design Studio", "Ventures", "Exports", "Hospitality"],
  partnership: ["Steel Traders", "Hardware Stores", "Pharma Distributors", "Silk House", "Sweets", "Printers", "Opticals", "Book House", "Agencies", "Enterprises"],
  proprietorship: ["Bakers", "Dental Clinic", "Physio Centre", "Fresh Mart", "Travels", "Mobiles", "Furnishings", "Tailors", "Medicals", "Fabricators"],
};

/** The mix of entities in a typical Bengaluru practice, repeated in this order. */
const ENTITY_CYCLE: readonly EntityType[] = [
  "pvt_ltd", "proprietorship", "individual", "partnership", "pvt_ltd", "llp", "proprietorship", "pvt_ltd",
  "individual", "partnership", "pvt_ltd", "huf", "llp", "proprietorship", "public_ltd", "pvt_ltd",
  "individual", "trust", "partnership", "pvt_ltd", "llp", "proprietorship", "section_8", "individual",
];

/** PAN 4th character by entity (§6.2). */
const PAN_HOLDER: Readonly<Record<EntityType, string>> = {
  proprietorship: "P",
  partnership: "F",
  llp: "F",
  pvt_ltd: "C",
  public_ltd: "C",
  section_8: "C",
  trust: "T",
  aop: "A",
  huf: "H",
  individual: "P",
  other: "A",
};

const STAFF: ReadonlyArray<{ fullName: string; role: "manager" | "employee"; designation: string; department: string }> = [
  { fullName: "Anita Rao", role: "manager", designation: "Audit Manager", department: "Assurance" },
  { fullName: "Suresh Kulkarni", role: "manager", designation: "Tax Manager", department: "Direct tax" },
  { fullName: "Ravi Kumar", role: "employee", designation: "Senior Accountant", department: "GST" },
  { fullName: "Deepa Nair", role: "employee", designation: "Audit Assistant", department: "Assurance" },
  { fullName: "Kiran Shetty", role: "employee", designation: "Tax Associate", department: "Direct tax" },
  { fullName: "Meghana Iyer", role: "employee", designation: "Article Assistant", department: "GST" },
  { fullName: "Arjun Patil", role: "employee", designation: "Accounts Executive", department: "Accounts" },
  { fullName: "Lakshmi Prasad", role: "employee", designation: "Company Secretarial Associate", department: "Company law" },
];

const GROUPS = ["Hegde Family Group", "Shetty Industries Group", "Kamath Hospitality Group"];

// =================================================================================================
// Plan: what to create, in memory (no I/O)
// =================================================================================================

export type StaffPlan = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  designation: string;
  department: string;
  role: "manager" | "employee";
};

export type ContactPlan = {
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  whatsapp: string | null;
  isPrimary: boolean;
  handles: ServiceType[];
};

export type ServicePlan = {
  id: string;
  serviceType: ServiceType;
  frequency: ServiceFrequency;
  /** Per billing occurrence, excl. GST. */
  feePaise: Paise;
};

export type ClientPlan = {
  id: string;
  displayName: string;
  legalName: string;
  entityType: EntityType;
  isIncorporated: boolean;
  dateOfBirthOrIncorporation: DateString;
  pan: string;
  tan: string | null;
  gstRegistration: "registered" | "unregistered";
  gstin: string | null;
  stateCode: string;
  email: string;
  phone: string;
  whatsapp: string;
  address: string;
  city: string;
  pincode: string;
  status: "active" | "pending" | "on_hold" | "inactive";
  priority: "low" | "medium" | "high" | "critical";
  ownerId: string;
  preparerId: string;
  reviewerId: string;
  groupIndex: number | null;
  turnoverPaise: Paise | null;
  turnoverFy: string;
  gstScheme: "monthly" | "qrmp" | null;
  taxAudit: "yes" | "no" | "review" | null;
  onboardedOn: DateString;
  contacts: ContactPlan[];
  services: ServicePlan[];
};

export type StagingPlan = { today: DateString; staff: StaffPlan[]; groups: string[]; clients: ClientPlan[] };

const CRORE = 1_00_00_000_00; // ₹1 crore in paise
const LAKH = 1_00_000_00; // ₹1 lakh in paise

function rupees(amount: number): Paise {
  return toPaise(amount);
}

/** A fee in whole rupees between `min` and `max`, in steps of ₹500. */
function fee(rand: Random, min: number, max: number): Paise {
  return rupees(Math.round(rand.int(min, max) / 500) * 500);
}

function companyLike(entity: EntityType): boolean {
  return entity === "pvt_ltd" || entity === "public_ltd" || entity === "section_8";
}

function planTurnover(rand: Random, entity: EntityType): Paise | null {
  switch (entity) {
    case "pvt_ltd":
      return rand.int(2, 60) * CRORE + rand.int(0, 99) * LAKH;
    case "public_ltd":
      return rand.int(40, 180) * CRORE;
    case "section_8":
    case "trust":
      return rand.int(30, 400) * LAKH;
    case "llp":
      return rand.int(50, 800) * LAKH;
    case "partnership":
      return rand.int(40, 600) * LAKH;
    case "proprietorship":
      return rand.int(15, 300) * LAKH;
    default:
      return null;
  }
}

function planServices(rand: Random, entity: EntityType, registered: boolean, scheme: "monthly" | "qrmp" | null, turnover: Paise | null): ServicePlan[] {
  const out: ServicePlan[] = [];
  const add = (serviceType: ServiceType, frequency: ServiceFrequency, feePaise: Paise) =>
    out.push({ id: randomUUID(), serviceType, frequency, feePaise });
  const big = turnover !== null && turnover > 10 * CRORE;
  if (registered) {
    if (scheme === "qrmp") add("gst", "quarterly", fee(rand, 4500, 9000));
    else add("gst", "monthly", big ? fee(rand, 8000, 15000) : fee(rand, 2500, 7500));
  }
  if (entity === "individual" || entity === "huf") {
    add("income_tax", "annual", fee(rand, 2500, 9000));
    return out;
  }
  add("income_tax", "annual", companyLike(entity) ? fee(rand, 25000, 100000) : fee(rand, 10000, 45000));
  if (companyLike(entity) || entity === "trust" || (entity !== "proprietorship" && rand.chance(0.55))) add("tds", "quarterly", fee(rand, 3000, 9000));
  if (companyLike(entity) || entity === "trust" || (turnover !== null && turnover > 1 * CRORE && rand.chance(0.7))) {
    add("audit", "annual", companyLike(entity) ? fee(rand, 60000, 300000) : fee(rand, 25000, 90000));
  }
  if (companyLike(entity) || entity === "llp") add("company_law", "annual", fee(rand, 12000, 45000));
  if ((entity === "pvt_ltd" || entity === "public_ltd") && rand.chance(0.5)) add("payroll", "monthly", fee(rand, 2500, 9000));
  if ((entity === "proprietorship" && rand.chance(0.6)) || ((entity === "llp" || entity === "partnership" || entity === "pvt_ltd") && rand.chance(0.35))) {
    add("bookkeeping", "monthly", fee(rand, 4000, 20000));
  }
  return out;
}

function planContacts(rand: Random, entity: EntityType, displayName: string, owner: { first: string; surname: string }, services: readonly ServicePlan[], serial: () => number): ContactPlan[] {
  const domain = `${slug(displayName)}.${SYNTHETIC_EMAIL_DOMAIN}`;
  const hasService = (s: ServiceType) => services.some((x) => x.serviceType === s);
  const contact = (name: string, role: string, isPrimary: boolean, handles: ServiceType[]): ContactPlan => {
    const phone = syntheticMobile(serial());
    return {
      id: randomUUID(),
      name,
      role,
      email: `${slug(name.split(" ")[0])}@${domain}`,
      phone,
      whatsapp: rand.chance(0.85) ? phone : null,
      isPrimary,
      handles,
    };
  };
  const ownerName = `${owner.first} ${owner.surname}`;
  if (entity === "individual" || entity === "huf") return [contact(ownerName, "Other", true, [])];
  const primaryRole = companyLike(entity) ? "Director" : entity === "proprietorship" ? "Promoter" : "Authorised Signatory";
  const list = [contact(ownerName, primaryRole, true, [])];
  const accountantHandles = (["gst", "tds", "bookkeeping", "payroll"] as const).filter(hasService);
  if (accountantHandles.length > 0 && (entity !== "proprietorship" || rand.chance(0.5))) {
    list.push(contact(`${rand.pick(FIRST_NAMES)} ${rand.pick(SURNAMES)}`, "Accountant", false, [...accountantHandles]));
  }
  if (companyLike(entity) && rand.chance(0.6)) {
    list.push(contact(`${rand.pick(FIRST_NAMES)} ${rand.pick(SURNAMES)}`, "CFO", false, (["income_tax", "audit"] as const).filter(hasService)));
  }
  return list;
}

/** Builds the whole synthetic practice in memory (deterministic for a given seed and today). */
export function planStagingData(opts: { clients: number; seed: number; today: DateString }): StagingPlan {
  const rand = createRandom(opts.seed);
  const staff: StaffPlan[] = STAFF.map((s, i) => ({
    id: randomUUID(),
    fullName: s.fullName,
    email: `${slug(s.fullName).replace(/-/g, ".")}@staff.${SYNTHETIC_EMAIL_DOMAIN}`,
    phone: syntheticMobile(90000 + i),
    designation: s.designation,
    department: s.department,
    role: s.role,
  }));
  const managers = staff.filter((s) => s.role === "manager");
  const employees = staff.filter((s) => s.role === "employee");

  let phoneSerial = 1;
  const serial = () => phoneSerial++;
  const usedNames = new Set<string>();
  const usedPans = new Set<string>();
  const clients: ClientPlan[] = [];

  for (let i = 0; clients.length < opts.clients; i++) {
    if (i > opts.clients * 20) throw new Error("Ran out of distinct synthetic names; ask for fewer clients.");
    const entity = ENTITY_CYCLE[i % ENTITY_CYCLE.length];
    const area = rand.pick(AREAS);
    const owner = { first: rand.pick(FIRST_NAMES), surname: rand.pick(SURNAMES) };
    let displayName: string;
    let legalName: string;
    switch (entity) {
      case "pvt_ltd": {
        const base = `${area.name} ${rand.pick(TRADES.company)}`;
        displayName = `${base} Pvt Ltd`;
        legalName = `${base} Private Limited`;
        break;
      }
      case "public_ltd": {
        const base = `${area.name} ${rand.pick(TRADES.company)}`;
        displayName = `${base} Ltd`;
        legalName = `${base} Limited`;
        break;
      }
      case "section_8":
        displayName = `${area.name} Learning Foundation`;
        legalName = displayName;
        break;
      case "llp":
        displayName = `${area.name} ${rand.pick(TRADES.llp)} LLP`;
        legalName = displayName;
        break;
      case "partnership":
        displayName = `Sri ${rand.pick(DEITIES)} ${rand.pick(TRADES.partnership)}`;
        legalName = `M/s ${displayName}`;
        break;
      case "proprietorship":
        displayName = `${area.name} ${rand.pick(TRADES.proprietorship)}`;
        legalName = `${owner.first} ${owner.surname}`;
        break;
      case "trust":
        displayName = `Sri ${rand.pick(DEITIES)} Education Trust`;
        legalName = displayName;
        break;
      case "huf":
        displayName = `${owner.first} ${owner.surname} HUF`;
        legalName = displayName;
        break;
      default:
        displayName = `${rand.chance(0.25) ? "Dr. " : ""}${owner.first} ${owner.surname}`;
        legalName = `${owner.first} ${owner.surname}`;
    }
    if (usedNames.has(displayName.toLowerCase())) continue;

    const personal = entity === "individual" || entity === "proprietorship";
    const initial = (personal ? owner.surname : displayName.replace(/^(Sri|Dr\.)\s+/, ""))[0].toUpperCase();
    const pan = syntheticPan(rand, PAN_HOLDER[entity], initial);
    if (usedPans.has(pan) || !validatePan(pan, { entityType: entity }).ok) continue;

    const turnover = planTurnover(rand, entity);
    const registered = turnover !== null && (entity !== "proprietorship" || turnover > 40 * LAKH || rand.chance(0.6));
    const outside = registered && entity !== "trust" && entity !== "section_8" && rand.chance(0.1) ? rand.pick(OTHER_STATES) : null;
    const stateCode = outside?.stateCode ?? "29";
    const gstin = registered ? syntheticGstin(stateCode, pan) : null;
    if (gstin !== null && !validateGstin(gstin).ok) continue;
    const scheme: "monthly" | "qrmp" | null = !registered
      ? null
      : turnover !== null && turnover > 5 * CRORE
        ? "monthly"
        : rand.chance(0.15)
          ? null
          : rand.chance(0.5)
            ? "qrmp"
            : "monthly";
    const services = planServices(rand, entity, registered, scheme, turnover);
    const hasTds = services.some((s) => s.serviceType === "tds");
    const tan = hasTds ? syntheticTan(rand, initial) : null;
    if (tan !== null && !validateTan(tan).ok) continue;

    usedNames.add(displayName.toLowerCase());
    usedPans.add(pan);
    const index = clients.length;
    const status = index % 23 === 22 ? "inactive" : index % 17 === 16 ? "on_hold" : index % 12 === 11 ? "pending" : "active";
    const preparer = employees[index % employees.length];
    const reviewer = managers[index % managers.length];
    const businessTurnover = entity === "individual" || entity === "huf" ? null : turnover;
    const taxAudit =
      businessTurnover === null ? null : businessTurnover > 10 * CRORE ? "yes" : businessTurnover > 1 * CRORE ? (rand.chance(0.6) ? "yes" : "review") : "no";
    const onboardedOn = addDays(opts.today, -rand.int(120, 1400));
    const dob = personal || entity === "huf" ? toDateString(rand.int(1958, 1995), rand.int(1, 12), rand.int(1, 28)) : toDateString(rand.int(1985, 2022), rand.int(1, 12), rand.int(1, 28));
    const phone = syntheticMobile(serial());

    clients.push({
      id: randomUUID(),
      displayName,
      legalName,
      entityType: entity,
      isIncorporated: companyLike(entity) || entity === "llp",
      dateOfBirthOrIncorporation: dob,
      pan,
      tan,
      gstRegistration: registered ? "registered" : "unregistered",
      gstin,
      stateCode,
      email: `accounts@${slug(displayName)}.${SYNTHETIC_EMAIL_DOMAIN}`,
      phone,
      whatsapp: phone,
      address: `No. ${rand.int(1, 240)}, ${rand.pick(STREETS)}, ${outside?.area ?? area.name}`,
      city: outside?.city ?? "Bengaluru",
      pincode: outside?.pincode ?? area.pincode,
      status,
      priority: rand.pick(["low", "medium", "medium", "medium", "high", "critical"] as const),
      ownerId: index % 3 === 0 ? reviewer.id : preparer.id,
      preparerId: preparer.id,
      reviewerId: reviewer.id,
      groupIndex: index % 9 === 4 ? Math.floor(index / 9) % GROUPS.length : null,
      turnoverPaise: turnover,
      turnoverFy: previousFinancialYear(financialYearOf(opts.today)),
      gstScheme: scheme,
      taxAudit,
      onboardedOn,
      contacts: planContacts(rand, entity, displayName, owner, services, serial),
      services,
    });
  }
  return { today: opts.today, staff, groups: [...GROUPS], clients };
}

// =================================================================================================
// Database helpers
// =================================================================================================

type SqlValue = string | number | boolean | null | readonly string[];
type Row = Record<string, SqlValue>;

/** One multi-row INSERT per chunk (parameters stay well below Postgres's 65,535 limit). */
async function insertRows(db: Client, table: string, rows: readonly Row[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const perChunk = Math.max(1, Math.floor(20000 / columns.length));
  for (let start = 0; start < rows.length; start += perChunk) {
    const params: SqlValue[] = [];
    const tuples = rows.slice(start, start + perChunk).map(
      (row) =>
        `(${columns
          .map((c) => {
            params.push(row[c] ?? null);
            return `$${params.length}`;
          })
          .join(", ")})`,
    );
    await db.query(`insert into public.${table} (${columns.join(", ")}) values ${tuples.join(", ")}`, params as unknown[]);
  }
}

/** `count` numbers from the locked counter (§0.1 rule 6, §5.11: next_document_number), in order. */
async function takeNumbers(db: Client, key: string, date: DateString, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const res = await db.query<{ n: string }>("select public.next_document_number($1, $2::date) as n from generate_series(1, $3::int)", [key, date, count]);
  return res.rows.map((r) => r.n);
}

/** A date-only fact at a time of day in IST, as a timestamptz literal. */
function istTime(date: DateString, time = "11:00"): string {
  return `${date}T${time}:00+05:30`;
}

function monthLabelOf(date: DateString): string {
  const { year, month } = parseDateString(date);
  return `${MONTH_ABBR[month - 1]} ${year}`;
}

function firstOfMonth(date: DateString): DateString {
  const { year, month } = parseDateString(date);
  return toDateString(year, month, 1);
}

function minDate(a: DateString, b: DateString): DateString {
  return compareDates(a, b) <= 0 ? a : b;
}

// =================================================================================================
// What exists in the target database
// =================================================================================================

type Preflight = {
  schemaVersion: string;
  actorId: string;
  partnerEmployeeId: string | null;
  sacMap: SacMap;
  defaultSac: string;
  firmGstin: string | null;
  firmStateCode: string;
  taxRate: number;
  paymentTermsDays: number;
  invoiceTerms: string | null;
  rules: DueDateRule[];
  overrides: DueDateOverride[];
  ops: OpsTemplate[];
  templates: Map<string, { id: string; items: Array<{ title: string; offsetDays: number; sortOrder: number }> }>;
};

class Refusal extends Error {}

/** The nil UUID, recorded as "who did it" when the database has no Partner yet. */
const NO_ACTOR = "00000000-0000-0000-0000-000000000000";

async function preflight(db: Client): Promise<Preflight | "already_seeded"> {
  const meta = await db.query<{ value: string }>("select value from public.app_meta where key = 'schema_version'").catch(() => null);
  if (!meta || meta.rows.length === 0) throw new Refusal("This database isn't migrated (no app_meta.schema_version). Apply supabase/migrations first.");
  const fn = await db.query<{ ok: boolean }>("select to_regprocedure('public.next_document_number(text,date)') is not null as ok");
  if (!fn.rows[0]?.ok) throw new Refusal("next_document_number(text, date) is missing. Apply every migration first.");

  const firm = await db.query<{
    sac_by_service: SacMap | null;
    default_sac: string;
    gstin: string | null;
    state_code: string;
    default_tax_rate: string;
    payment_terms_days: number;
    invoice_terms: string | null;
  }>("select sac_by_service, default_sac, gstin::text as gstin, state_code, default_tax_rate::text, payment_terms_days, invoice_terms from public.firm_settings where id = 1");
  if (firm.rows.length === 0) throw new Refusal("firm_settings is empty. Apply the production seed (supabase/seed/*.sql) first.");

  const clients = await db.query<{ total: string; ours: string }>(
    "select count(*)::text as total, count(*) filter (where notes = $1)::text as ours from public.clients",
    [SYNTHETIC_MARKER],
  );
  const total = Number(clients.rows[0].total);
  const ours = Number(clients.rows[0].ours);
  if (total > ours) {
    throw new Refusal(`This database already has ${total - ours} client(s) this script didn't create. It fills only an empty staging database and never mixes with real data.`);
  }
  if (ours > 0) return "already_seeded";

  const actor = await db.query<{ id: string; employee_id: string | null }>(
    `select p.id, e.id as employee_id from public.profiles p left join public.employees e on e.profile_id = p.id
     where p.role = 'partner' and p.is_active order by p.created_at limit 1`,
  );

  const ruleRows = await db.query<DueDateRuleRow>("select * from public.due_date_rules where is_active");
  const rules = ruleRows.rows.map((r) => parseDueDateRuleRow(r)).flatMap((r) => (r.ok ? [r.value] : []));
  const overrideRows = await db.query<DueDateOverrideRow>("select id, rule_code, period_label, original_due::text, extended_due::text, scope, source_ref from public.due_date_overrides");
  const overrides = overrideRows.rows.map((r) => parseDueDateOverrideRow(r)).flatMap((r) => (r.ok ? [r.value] : []));
  const opsRows = await db.query<{
    service_type: ServiceType;
    compliance_type: OpsTemplate["complianceType"];
    title: string;
    description: string | null;
    frequency: ServiceFrequency;
    due_day_of_month: number;
    due_month: number | null;
    period_offset: number;
    reminder_days: number;
  }>("select service_type, compliance_type, title, description, frequency, due_day_of_month, due_month, period_offset, reminder_days from public.recurring_compliance_templates where is_active");
  const ops: OpsTemplate[] = opsRows.rows.map((r) => ({
    serviceType: r.service_type,
    complianceType: r.compliance_type,
    title: r.title,
    description: r.description,
    frequency: r.frequency,
    dueDayOfMonth: r.due_day_of_month,
    dueMonth: r.due_month,
    periodOffset: r.period_offset,
    reminderDays: r.reminder_days,
    isActive: true,
  }));

  const itemRows = await db.query<{ id: string; name: string; title: string | null; offset_days: number | null; sort_order: number | null }>(
    `select t.id, t.name::text as name, i.title, i.offset_days, i.sort_order
     from public.job_templates t left join public.job_template_items i on i.template_id = t.id
     where t.is_active order by t.name, i.sort_order`,
  );
  const templates: Preflight["templates"] = new Map();
  for (const r of itemRows.rows) {
    const t = templates.get(r.name) ?? { id: r.id, items: [] };
    if (r.title !== null) t.items.push({ title: r.title, offsetDays: r.offset_days ?? 0, sortOrder: r.sort_order ?? 0 });
    templates.set(r.name, t);
  }

  const f = firm.rows[0];
  return {
    schemaVersion: meta.rows[0].value,
    actorId: actor.rows[0]?.id ?? NO_ACTOR,
    partnerEmployeeId: actor.rows[0]?.employee_id ?? null,
    sacMap: f.sac_by_service ?? GST_DEFAULTS.sacByService,
    defaultSac: f.default_sac,
    firmGstin: f.gstin,
    firmStateCode: f.state_code,
    taxRate: Number(f.default_tax_rate),
    paymentTermsDays: f.payment_terms_days,
    invoiceTerms: f.invoice_terms,
    rules: rules.length > 0 ? rules : [...DUE_DATE_RULE_SEED],
    overrides: rules.length > 0 ? overrides : [...DUE_DATE_OVERRIDE_SEED],
    ops: ops.length > 0 ? ops : [...OPS_TEMPLATE_DEFAULTS],
    templates,
  };
}

// =================================================================================================
// Work: which calendar events get a task, and the task's state
// =================================================================================================

/** Events that get a task: the primary rule, the rules its task also covers, and its job template. */
const TASK_GROUPS: ReadonlyArray<{ primary: readonly string[]; also: readonly string[]; template: string | null; title?: (period: string) => string; minutes: number }> = [
  { primary: ["GSTR1_MONTHLY"], also: ["GSTR3B_MONTHLY"], template: "Monthly GST filing", title: (p) => `GST returns (GSTR-1 and GSTR-3B) for ${p}`, minutes: 240 },
  { primary: ["GSTR1_QRMP"], also: [], template: null, minutes: 150 },
  { primary: ["GSTR3B_QRMP"], also: [], template: null, minutes: 120 },
  { primary: ["TDS_RETURN_Q1", "TDS_RETURN_Q2", "TDS_RETURN_Q3", "TDS_RETURN_Q4"], also: ["FORM16A"], template: "Quarterly TDS return", minutes: 180 },
  { primary: ["ITR_NON_AUDIT_1_2", "ITR_NON_AUDIT_3_4", "ITR_NON_AUDIT_5"], also: [], template: "ITR (non-audit)", minutes: 180 },
  { primary: ["TAX_AUDIT_REPORT"], also: [], template: "Tax audit", minutes: 2400 },
  { primary: ["ITR_AUDIT"], also: [], template: null, minutes: 300 },
  { primary: ["AOC4"], also: ["ADT1", "MGT7"], template: "ROC annual filing", title: (p) => `ROC annual filing for ${p}`, minutes: 360 },
  { primary: ["LLP_FORM8"], also: ["LLP_FORM11"], template: "LLP annual filing", title: (p) => `LLP annual filing for ${p}`, minutes: 180 },
  { primary: ["GSTR9"], also: ["GSTR9C"], template: "GST annual return (GSTR-9/9C)", title: (p) => `GST annual return for ${p}`, minutes: 600 },
];

/** Returns that leave an acknowledgement worth a filing record (§7.6.5, §7.15.2). */
const FILED_RULES = new Set([
  "GSTR1_MONTHLY", "GSTR3B_MONTHLY", "GSTR1_QRMP", "GSTR3B_QRMP", "TDS_RETURN_Q1", "TDS_RETURN_Q2", "TDS_RETURN_Q3", "TDS_RETURN_Q4",
  "ITR_NON_AUDIT_1_2", "ITR_NON_AUDIT_3_4", "ITR_NON_AUDIT_5", "TAX_AUDIT_REPORT", "ITR_AUDIT", "AOC4", "ADT1", "MGT7", "LLP_FORM8", "LLP_FORM11",
]);

const WAITING_ON = ["the purchase register", "the bank statements", "the sales register", "Form 16 from the employer", "the board resolution", "the fixed asset register", "confirmation of the closing stock"];

function taskStatusFor(rand: Random, daysUntilDue: number): TaskStatus {
  if (rand.chance(0.03)) return "on_hold";
  if (daysUntilDue < 0) return rand.chance(0.82) ? "filed_done" : rand.pick(["data_awaited", "data_awaited", "in_progress", "under_review"] as const);
  if (daysUntilDue <= 7) return rand.pick(["in_progress", "in_progress", "data_awaited", "under_review", "not_started"] as const);
  return rand.pick(["not_started", "not_started", "not_started", "in_progress", "data_awaited"] as const);
}

function priorityFor(status: TaskStatus, daysUntilDue: number): TaskPriority {
  if (status !== "filed_done" && daysUntilDue < 0) return "urgent";
  if (daysUntilDue <= 7) return "high";
  return daysUntilDue <= 20 ? "medium" : "low";
}

function workflowFor(status: TaskStatus): "not_started" | "documents_awaited" | "in_progress" | "under_review" | "filed" {
  switch (status) {
    case "data_awaited":
      return "documents_awaited";
    case "in_progress":
    case "on_hold":
      return "in_progress";
    case "under_review":
      return "under_review";
    case "filed_done":
      return "filed";
    default:
      return "not_started";
  }
}

function acknowledgementFor(rand: Random, ruleCode: string, stateCode: string, filedOn: DateString): string {
  const { year, month } = parseDateString(filedOn);
  if (ruleCode.startsWith("GSTR")) {
    let tail = "";
    for (let i = 0; i < 7; i++) tail += rand.chance(0.7) ? String(rand.int(0, 9)) : letter(rand);
    return `AA${stateCode}${String(month).padStart(2, "0")}${String(year % 100).padStart(2, "0")}${tail}`;
  }
  if (["AOC4", "ADT1", "MGT7", "LLP_FORM8", "LLP_FORM11"].includes(ruleCode)) return `AB${digits(rand, 7)}`;
  return digits(rand, 15);
}

// =================================================================================================
// Writing
// =================================================================================================

export type StagingCounts = Record<string, number>;

const SERVICE_LINE: Readonly<Record<ServiceType, string>> = {
  gst: "GST return filing",
  income_tax: "Income-tax return and computation",
  tds: "TDS returns",
  payroll: "Payroll compliance (PF, ESIC, PT)",
  bookkeeping: "Accounting and bookkeeping",
  audit: "Audit fee",
  company_law: "ROC annual filings",
  incorporation: "Incorporation",
  other: "Professional services",
};

/**
 * Above the turnover limit an invoice needs a 6-digit SAC (§6.4). When the firm's map has only the
 * 4-digit default for a service, synthetic invoices use the closest §6.4 code instead.
 */
const SIX_DIGIT_SAC: Readonly<Record<ServiceType, string>> = {
  gst: "998231",
  income_tax: "998231",
  tds: "998231",
  payroll: "998222",
  bookkeeping: "998222",
  audit: "998221",
  company_law: "998231",
  incorporation: "998231",
  other: "998231",
};

async function writePlan(db: Client, plan: StagingPlan, pre: Preflight, rand: Random): Promise<StagingCounts> {
  const today = plan.today;
  const counts: StagingCounts = {};
  const bump = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
  };

  // Staff records, without logins (§4.5: a person can exist before they have a login) ----------------
  await insertRows(
    db,
    "employees",
    plan.staff.map((s) => ({
      id: s.id,
      full_name: s.fullName,
      email: s.email,
      phone: s.phone,
      whatsapp: s.phone,
      department: s.department,
      designation: s.designation,
      date_of_joining: addDays(today, -rand.int(200, 2400)),
      staff_role: s.role,
      is_active: true,
    })),
  );
  bump("employees", plan.staff.length);

  // Groups ----------------------------------------------------------------------------------------
  const groupIds = plan.groups.map(() => randomUUID());
  await insertRows(db, "client_groups", plan.groups.map((name, i) => ({ id: groupIds[i], name, notes: SYNTHETIC_MARKER })));
  bump("client_groups", plan.groups.length);

  // Clients and what hangs off them -------------------------------------------------------------------
  const codes = await takeNumbers(db, "client_code", today, plan.clients.length);
  await insertRows(
    db,
    "clients",
    plan.clients.map((c, i) => ({
      id: c.id,
      client_code: codes[i],
      display_name: c.displayName,
      legal_name: c.legalName,
      entity_type: c.entityType,
      is_incorporated: c.isIncorporated,
      date_of_birth_or_incorporation: c.dateOfBirthOrIncorporation,
      pan: c.pan,
      tan: c.tan,
      gst_registration: c.gstRegistration,
      gstin: c.gstin,
      state_code: c.stateCode,
      email: c.email,
      phone: c.phone,
      whatsapp: c.whatsapp,
      address: c.address,
      city: c.city,
      pincode: c.pincode,
      notes: SYNTHETIC_MARKER,
      status: c.status,
      priority: c.priority,
      owner_employee_id: c.ownerId,
      group_id: c.groupIndex === null ? null : groupIds[c.groupIndex],
      annual_turnover: c.turnoverPaise === null ? null : paiseToDecimalString(c.turnoverPaise),
      turnover_fy: c.turnoverPaise === null ? null : c.turnoverFy,
      gst_scheme: c.gstScheme,
      tax_audit_applicable: c.taxAudit,
      onboarded_at: c.status === "pending" ? null : istTime(c.onboardedOn),
      onboarded_by: c.status === "pending" ? null : pre.actorId === NO_ACTOR ? null : pre.actorId,
      created_by: pre.actorId === NO_ACTOR ? null : pre.actorId,
      created_at: istTime(c.onboardedOn, "10:00"),
    })),
  );
  bump("clients", plan.clients.length);

  await insertRows(
    db,
    "client_contacts",
    plan.clients.flatMap((c) =>
      c.contacts.map((k) => ({ id: k.id, client_id: c.id, name: k.name, role: k.role, email: k.email, phone: k.phone, whatsapp: k.whatsapp, is_primary: k.isPrimary, handles: k.handles })),
    ),
  );
  bump("client_contacts", plan.clients.reduce((n, c) => n + c.contacts.length, 0));

  await insertRows(
    db,
    "client_services",
    plan.clients.flatMap((c) =>
      c.services.map((s) => ({
        id: s.id,
        client_id: c.id,
        service_type: s.serviceType,
        frequency: s.frequency,
        is_active: c.status !== "inactive",
        agreed_fee: paiseToDecimalString(s.feePaise),
        fee_agreed_at: istTime(c.onboardedOn),
      })),
    ),
  );
  bump("client_services", plan.clients.reduce((n, c) => n + c.services.length, 0));

  await insertRows(
    db,
    "client_team_members",
    plan.clients.flatMap((c) => [
      { client_id: c.id, employee_id: c.preparerId, team_role: "preparer" },
      { client_id: c.id, employee_id: c.reviewerId, team_role: "review_manager" },
      ...(pre.partnerEmployeeId ? [{ client_id: c.id, employee_id: pre.partnerEmployeeId, team_role: "engagement_partner" }] : []),
    ]),
  );
  bump("client_team_members", plan.clients.length * (pre.partnerEmployeeId ? 3 : 2));

  // The calendar, from the app's own engine (§6.7, §7.7) ----------------------------------------------
  const working = plan.clients.filter((c) => c.status === "active" || c.status === "on_hold");
  const eventRows: Row[] = [];
  const eventsByClient = new Map<string, Array<CalendarEvent & { id: string }>>();
  const backfillFrom = addMonths(today, -2);
  for (const c of working) {
    const profile: CalendarClientProfile = {
      id: c.id,
      serviceTypes: c.services.map((s) => s.serviceType),
      entityType: c.entityType,
      gstScheme: c.gstScheme,
      stateCode: c.stateCode,
      turnover: c.turnoverPaise,
      taxAuditApplicable: c.taxAudit,
    };
    const generated = [
      ...generateEvents(profile, pre.rules, pre.overrides, { today, from: backfillFrom }),
      ...generateOpsEvents(profile, pre.ops, { today, from: backfillFrom }),
    ];
    const seen = new Set<string>();
    const list: Array<CalendarEvent & { id: string }> = [];
    for (const ev of generated) {
      if (seen.has(ev.dedupeKey)) continue;
      seen.add(ev.dedupeKey);
      list.push({ ...ev, id: randomUUID() });
    }
    eventsByClient.set(c.id, list);
  }

  // Tasks for the events around today, with checklists from the job templates (§7.6, §16) ------------
  const taskRows: Row[] = [];
  const checklistRows: Row[] = [];
  const historyRows: Row[] = [];
  const eventState = new Map<string, { status: "pending" | "completed"; workflow: string; completedAt: string | null; taskId: string | null }>();
  const taskNumbers: string[] = [];
  type PlannedTask = { row: Row; clientId: string; status: TaskStatus; due: DateString; completedOn: DateString | null; template: string | null };
  const planned: PlannedTask[] = [];

  const planTask = (c: ClientPlan, args: { title: string; due: DateString; serviceType: ServiceType | null; fy: string; period: string; template: string | null; minutes: number; eventId: string | null }) => {
    const days = diffDays(args.due, today);
    const status = taskStatusFor(rand, days);
    const accepted = status !== "not_started" || rand.chance(0.5);
    const lead = pre.templates.get(args.template ?? "")?.items.reduce((m, i) => Math.max(m, i.offsetDays), 0) ?? 10;
    const createdOn = minDate(addDays(args.due, -Math.max(lead, 5) - rand.int(0, 3)), today);
    const completedOn = status === "filed_done" ? minDate(addDays(args.due, -rand.int(0, 5)), today) : null;
    const id = randomUUID();
    const row: Row = {
      id,
      task_number: "",
      client_id: c.id,
      title: args.title,
      service_type: args.serviceType,
      financial_year: args.fy,
      period_label: args.period,
      status,
      priority: priorityFor(status, days),
      due_date: args.due,
      completion_date: completedOn === null ? null : istTime(completedOn, "17:30"),
      on_hold_reason: status === "on_hold" ? "The client has asked us to wait for revised figures." : null,
      assigned_employee_id: c.preparerId,
      reviewer_employee_id: c.reviewerId,
      acceptance_status: accepted ? "accepted" : "pending",
      accepted_at: accepted ? istTime(createdOn, "10:15") : null,
      estimated_minutes: args.minutes,
      remarks: status === "data_awaited" ? `Waiting for ${rand.pick(WAITING_ON)}.` : null,
      compliance_event_id: args.eventId,
      source_template_id: args.template ? pre.templates.get(args.template)?.id ?? null : null,
      created_by: pre.actorId,
      created_at: istTime(createdOn, "09:45"),
    };
    planned.push({ row, clientId: c.id, status, due: args.due, completedOn, template: args.template });
    return { id, status, completedOn };
  };

  for (const c of working) {
    const events = eventsByClient.get(c.id) ?? [];
    for (const group of TASK_GROUPS) {
      for (const ev of events.filter((e) => e.ruleCode !== null && group.primary.includes(e.ruleCode))) {
        const days = diffDays(ev.dueDate, today);
        if (days < -45 || days > 35) continue;
        const task = planTask(c, {
          title: group.title ? group.title(ev.filingPeriod) : ev.title,
          due: ev.dueDate,
          serviceType: ev.serviceType,
          fy: ev.financialYear,
          period: ev.filingPeriod,
          template: group.template && pre.templates.has(group.template) ? group.template : null,
          minutes: group.minutes,
          eventId: ev.id,
        });
        const linked = [ev, ...events.filter((e) => e.ruleCode !== null && group.also.includes(e.ruleCode) && e.financialYear === ev.financialYear && (e.filingPeriod === ev.filingPeriod || ev.filingPeriod.startsWith("FY ")))];
        for (const e of linked) {
          const done = task.status === "filed_done" && (e === ev || compareDates(e.dueDate, today) < 0);
          eventState.set(e.id, {
            status: done ? "completed" : "pending",
            workflow: done ? "filed" : workflowFor(task.status === "filed_done" ? "in_progress" : task.status),
            completedAt: done ? istTime(minDate(task.completedOn ?? today, e.dueDate), "17:30") : null,
            taskId: task.id,
          });
        }
      }
    }
    // Monthly bookkeeping: last month's books (due the 20th) and this month's (§16 template)
    if (c.services.some((s) => s.serviceType === "bookkeeping") && pre.templates.has("Monthly bookkeeping")) {
      for (const monthsBack of [1, 0]) {
        const periodStart = firstOfMonth(addMonths(today, -monthsBack));
        const due = toDateString(parseDateString(addMonths(periodStart, 1)).year, parseDateString(addMonths(periodStart, 1)).month, 20);
        planTask(c, {
          title: `Monthly bookkeeping for ${monthLabelOf(periodStart)}`,
          due,
          serviceType: "bookkeeping",
          fy: financialYearOf(periodStart),
          period: monthLabelOf(periodStart),
          template: "Monthly bookkeeping",
          minutes: 480,
          eventId: null,
        });
      }
    }
  }

  // Numbers for the tasks, then the rows, their checklists and status history ------------------------
  taskNumbers.push(...(await takeNumbers(db, "task", today, planned.length)));
  planned.forEach((p, i) => {
    p.row.task_number = taskNumbers[i];
    taskRows.push(p.row);
    const taskId = String(p.row.id);
    const items = p.template ? pre.templates.get(p.template)?.items ?? [] : [];
    for (const item of items) {
      const itemDue = addDays(p.due, -item.offsetDays);
      const done =
        p.status === "filed_done" ||
        ((p.status === "in_progress" || p.status === "under_review") && compareDates(itemDue, today) <= 0) ||
        (p.status === "data_awaited" && compareDates(itemDue, today) <= 0 && item.sortOrder > 2);
      checklistRows.push({
        task_id: taskId,
        title: item.title,
        done,
        done_at: done ? istTime(minDate(itemDue, p.completedOn ?? today), "16:00") : null,
        due_offset_days: item.offsetDays,
        sort_order: item.sortOrder,
      });
    }
    if (p.status !== "not_started") {
      const started = String(p.row.created_at).slice(0, 10);
      const startedWork = minDate(addDays(started, 1), p.completedOn ?? today);
      historyRows.push({ task_id: taskId, from_status: "not_started", to_status: p.status === "filed_done" ? "in_progress" : p.status, reason: p.status === "on_hold" ? String(p.row.on_hold_reason) : null, changed_by: pre.actorId, changed_at: istTime(startedWork, "11:00") });
      if (p.status === "filed_done" && p.completedOn) {
        historyRows.push({ task_id: taskId, from_status: "in_progress", to_status: "under_review", reason: null, changed_by: pre.actorId, changed_at: istTime(p.completedOn, "12:00") });
        historyRows.push({ task_id: taskId, from_status: "under_review", to_status: "filed_done", reason: null, changed_by: pre.actorId, changed_at: istTime(p.completedOn, "17:30") });
      }
    }
  });

  // Events go in first (tasks point at them), then tasks, then the events' task links ----------------
  for (const c of working) {
    for (const ev of eventsByClient.get(c.id) ?? []) {
      const state = eventState.get(ev.id);
      const past = compareDates(ev.dueDate, today) < 0;
      const autoDone = !state && past && rand.chance(0.9);
      const insert = toComplianceEventInsert(ev);
      eventRows.push({
        id: ev.id,
        client_id: insert.client_id,
        type: insert.type,
        form_code: insert.form_code,
        title: insert.title,
        description: insert.description,
        financial_year: insert.financial_year,
        filing_period: insert.filing_period,
        period_start: insert.period_start,
        period_end: insert.period_end,
        due_date: insert.due_date,
        status: state?.status ?? (autoDone ? "completed" : "pending"),
        workflow_status: state?.workflow ?? (autoDone ? (ev.isStatutory ? "filed" : "completed") : "not_started"),
        is_statutory: insert.is_statutory,
        source: insert.source,
        reminder_days: insert.reminder_days,
        completed_at: state?.completedAt ?? (autoDone ? istTime(addDays(ev.dueDate, -rand.int(0, 4)), "17:00") : null),
        notes: insert.notes,
        dedupe_key: insert.dedupe_key,
        rule_code: insert.rule_code,
        source_ref: insert.source_ref,
        original_due_date: insert.original_due_date,
        override_id: insert.override_id,
        agm_date: insert.agm_date,
        is_provisional: insert.is_provisional,
      });
    }
  }
  await insertRows(db, "compliance_events", eventRows);
  bump("compliance_events", eventRows.length);
  await insertRows(db, "tasks", taskRows);
  bump("tasks", taskRows.length);
  await insertRows(db, "task_checklist_items", checklistRows);
  bump("task_checklist_items", checklistRows.length);
  await insertRows(db, "task_status_history", historyRows);
  bump("task_status_history", historyRows.length);
  const links = [...eventState.entries()].filter(([, s]) => s.taskId !== null);
  for (let i = 0; i < links.length; i += 500) {
    const chunk = links.slice(i, i + 500);
    await db.query(
      "update public.compliance_events e set task_id = v.task_id from unnest($1::uuid[], $2::uuid[]) as v(event_id, task_id) where e.id = v.event_id",
      [chunk.map(([id]) => id), chunk.map(([, s]) => s.taskId)],
    );
  }

  // Filing records for what was filed (§7.6.5, §7.15.2) ----------------------------------------------
  const clientById = new Map(plan.clients.map((c) => [c.id, c]));
  const eventById = new Map([...eventsByClient.values()].flat().map((e) => [e.id, e]));
  const filingRows: Row[] = [];
  for (const row of eventRows) {
    if (row.status !== "completed" || !FILED_RULES.has(String(row.rule_code))) continue;
    const c = clientById.get(String(row.client_id));
    if (!c) continue;
    const filedOn = String(row.completed_at).slice(0, 10);
    filingRows.push({
      client_id: c.id,
      financial_year: String(row.financial_year),
      filing_type: String(row.form_code ?? row.title),
      service_type: eventById.get(String(row.id))?.serviceType ?? null,
      period: row.filing_period,
      filed_on: filedOn,
      acknowledgement_no: acknowledgementFor(rand, String(row.rule_code), c.stateCode, filedOn),
      task_id: eventState.get(String(row.id))?.taskId ?? null,
      compliance_event_id: String(row.id),
      created_by: pre.actorId === NO_ACTOR ? null : pre.actorId,
    });
  }
  await insertRows(db, "filing_records", filingRows);
  bump("filing_records", filingRows.length);

  // Invoices and receipts (§7.9), oldest first so FY-scoped numbers follow the dates -----------------
  type PlannedInvoice = { client: ClientPlan; issue: DateString; period: string; lines: Array<{ description: string; serviceType: ServiceType; feePaise: Paise; reimbursement: boolean }>; outcome: "draft" | "unpaid" | "partial" | "paid" };
  const invoices: PlannedInvoice[] = [];
  for (const c of working) {
    if (c.services.length === 0) continue;
    const recurring = c.services.filter((s) => s.frequency === "monthly" || s.frequency === "quarterly");
    for (const monthsBack of [2, 1, 0]) {
      const periodStart = firstOfMonth(addMonths(today, -monthsBack - 1));
      const issue = addDays(firstOfMonth(addMonths(today, -monthsBack)), rand.int(1, 4));
      if (compareDates(issue, today) > 0) continue;
      const quarterEnd = parseDateString(periodStart).month % 3 === 0;
      const lines: PlannedInvoice["lines"] = [];
      for (const s of recurring) {
        if (s.frequency === "quarterly" && !quarterEnd) continue;
        const label = s.frequency === "quarterly" ? quarterLabel(periodStart) : monthLabelOf(periodStart);
        lines.push({ description: `${SERVICE_LINE[s.serviceType]} for ${label}`, serviceType: s.serviceType, feePaise: s.feePaise, reimbursement: false });
      }
      if (monthsBack === 2) {
        for (const s of c.services.filter((x) => x.frequency === "annual" && rand.chance(0.35))) {
          lines.push({ description: `${SERVICE_LINE[s.serviceType]}, FY ${previousFinancialYear(financialYearOf(today))}`, serviceType: s.serviceType, feePaise: s.feePaise, reimbursement: false });
        }
        if (c.services.some((s) => s.serviceType === "company_law") && rand.chance(0.3)) {
          lines.push({ description: reimbursementDescription("Government filing fees paid on your behalf"), serviceType: "company_law", feePaise: rupees(rand.int(3, 24) * 100), reimbursement: true });
        }
      }
      if (lines.length === 0) continue;
      // Older invoices are mostly settled; this month's are a mix of drafts, paid and still open.
      const roll = rand.next();
      const [draftUpTo, paidUpTo, partialUpTo] = monthsBack === 0 ? [0.25, 0.6, 0.7] : monthsBack === 1 ? [0, 0.65, 0.8] : [0, 0.8, 0.9];
      const outcome: PlannedInvoice["outcome"] = roll < draftUpTo ? "draft" : roll < paidUpTo ? "paid" : roll < partialUpTo ? "partial" : "unpaid";
      invoices.push({ client: c, issue, period: monthLabelOf(periodStart), lines, outcome });
    }
  }
  invoices.sort((a, b) => compareDates(a.issue, b.issue));

  const invoiceRows: Row[] = [];
  const itemRows: Row[] = [];
  const issued: Array<{ id: string; invoice: PlannedInvoice; due: DateString; totalPaise: Paise; taxablePaise: Paise }> = [];
  for (const inv of invoices) {
    const c = inv.client;
    const placeOfSupply = c.stateCode;
    const totals = invoiceTotals(
      inv.lines.map((l) => ({ quantity: 1, ratePaise: l.feePaise, taxRate: pre.taxRate, isReimbursement: l.reimbursement })),
      placeOfSupply,
      pre.firmStateCode,
    );
    const id = randomUUID();
    const due = addDays(inv.issue, pre.paymentTermsDays);
    invoiceRows.push({
      id,
      client_id: c.id,
      issue_date: inv.issue,
      due_date: due,
      status: "draft",
      client_name_snapshot: c.legalName,
      client_address_snapshot: `${c.address}, ${c.city} ${c.pincode}`,
      client_gstin_snapshot: c.gstin,
      place_of_supply_code: placeOfSupply,
      firm_gstin_snapshot: pre.firmGstin,
      taxable_amount: paiseToDecimalString(totals.taxablePaise),
      cgst_amount: paiseToDecimalString(totals.cgstPaise),
      sgst_amount: paiseToDecimalString(totals.sgstPaise),
      igst_amount: paiseToDecimalString(totals.igstPaise),
      reimbursement_amount: paiseToDecimalString(totals.reimbursementPaise),
      round_off: paiseToDecimalString(totals.roundOffPaise),
      total_amount: paiseToDecimalString(totals.totalPaise),
      outstanding_amount: paiseToDecimalString(totals.totalPaise),
      service_type: inv.lines[0].serviceType,
      billing_period_label: inv.period,
      terms: pre.invoiceTerms,
      created_by: pre.actorId,
      created_at: istTime(inv.issue, "10:30"),
    });
    inv.lines.forEach((l, i) => {
      const choice = sacFor(l.serviceType, pre.sacMap, c.turnoverPaise, { individual: c.entityType === "individual" || c.entityType === "huf", defaultSac: pre.defaultSac });
      const sac = l.reimbursement ? pre.defaultSac : choice.ok ? choice.sac : SIX_DIGIT_SAC[l.serviceType];
      itemRows.push({
        invoice_id: id,
        description: l.description,
        service_type: l.serviceType,
        sac_code: sac,
        quantity: "1",
        rate: paiseToDecimalString(l.feePaise),
        amount: paiseToDecimalString(totals.lines[i].amountPaise),
        tax_rate: l.reimbursement ? "0" : String(pre.taxRate),
        is_reimbursement: l.reimbursement,
        sort_order: i + 1,
      });
    });
    if (inv.outcome !== "draft") issued.push({ id, invoice: inv, due, totalPaise: totals.totalPaise, taxablePaise: totals.taxablePaise });
  }
  await insertRows(db, "invoices", invoiceRows);
  await insertRows(db, "invoice_items", itemRows);
  bump("invoices", invoiceRows.length);
  bump("invoice_items", itemRows.length);

  // Issue: a number from the locked counter by issue date, then Sent (§7.9.2) -------------------------
  for (const iss of issued) {
    const [number] = await takeNumbers(db, "invoice", iss.invoice.issue, 1);
    await db.query(
      "update public.invoices set status = 'sent', invoice_number = $2, sent_at = $3, sent_channels = $4 where id = $1",
      [iss.id, number, istTime(iss.invoice.issue, "15:00"), ["email"]],
    );
  }
  bump("invoices_issued", issued.length);

  // Receipts, with the TDS a client deducts on the fee excluding GST (§6.5) ---------------------------
  const receiptRows: Row[] = [];
  for (const iss of issued) {
    if (iss.invoice.outcome !== "paid" && iss.invoice.outcome !== "partial") continue;
    const c = iss.invoice.client;
    const paidOn = minDate(addDays(iss.invoice.issue, rand.int(3, pre.paymentTermsDays + 10)), today);
    const rule = tdsRuleFor("professional", paidOn);
    const annualFees = c.services.reduce((sum, s) => sum + s.feePaise * (s.frequency === "monthly" ? 12 : s.frequency === "quarterly" ? 4 : 1), 0);
    const deducts = c.tan !== null && rule !== null && (rule.threshold === null || annualFees > rule.threshold.amountPaise);
    const tds = deducts && rule ? percentOf(iss.taxablePaise, rule.ratePercent) : 0;
    const full = iss.totalPaise - tds;
    const received = iss.invoice.outcome === "paid" ? full : Math.max(100, Math.round(full * (rand.int(30, 70) / 100)));
    const method = rand.pick(["bank_transfer", "bank_transfer", "upi", "cheque"] as const);
    receiptRows.push({
      receipt_number: "",
      invoice_id: iss.id,
      payment_date: paidOn,
      amount_received: paiseToDecimalString(received),
      tds_amount: paiseToDecimalString(iss.invoice.outcome === "paid" ? tds : 0),
      tds_section: iss.invoice.outcome === "paid" && tds > 0 && rule ? rule.section : null,
      method,
      reference: method === "cheque" ? digits(rand, 6) : method === "upi" ? `UPI${digits(rand, 12)}` : `UTR${digits(rand, 12)}`,
      deposited_to: "Current account",
      recorded_by: pre.actorId,
      tds_status: "expected",
      tds_quarter: iss.invoice.outcome === "paid" && tds > 0 ? `Q${quarterOf(paidOn)} ${financialYearOf(paidOn)}` : null,
      deductor_tan: iss.invoice.outcome === "paid" && tds > 0 ? c.tan : null,
      created_at: istTime(paidOn, "16:00"),
    });
  }
  const receiptNumbers = await takeNumbers(db, "receipt", today, receiptRows.length);
  receiptRows.forEach((r, i) => {
    r.receipt_number = receiptNumbers[i];
  });
  await insertRows(db, "payment_receipts", receiptRows);
  bump("payment_receipts", receiptRows.length);

  return counts;
}

// =================================================================================================
// Command line
// =================================================================================================

export type StagingArgs = { clients: number; seed: number; today: DateString | null; dryRun: boolean; help: boolean };

/** Parses the command line; throws a plain sentence for anything it doesn't understand. */
export function parseArgs(argv: readonly string[]): StagingArgs {
  const out: StagingArgs = { clients: STAGING_DEFAULTS.clients, seed: STAGING_DEFAULTS.seed, today: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Refusal(`${arg} needs a value.`);
      return v;
    };
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--clients") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > STAGING_DEFAULTS.maxClients) throw new Refusal(`--clients must be a whole number from 1 to ${STAGING_DEFAULTS.maxClients}.`);
      out.clients = n;
    } else if (arg === "--seed") {
      const n = Number(value());
      if (!Number.isInteger(n)) throw new Refusal("--seed must be a whole number.");
      out.seed = n;
    } else if (arg === "--today") {
      const d = value();
      if (!isDateString(d)) throw new Refusal("--today must be a date written YYYY-MM-DD.");
      out.today = d;
    } else throw new Refusal(`Unknown option ${arg}. Try --help.`);
  }
  return out;
}

const HELP = `Synthetic data for a staging database (never production).

  STAGING_DATABASE_URL=postgres://… [SEED_TARGET=staging] npx tsx scripts/seed-staging.ts [options]

  --clients <n>   how many synthetic clients (default ${STAGING_DEFAULTS.clients}, at most ${STAGING_DEFAULTS.maxClients})
  --seed <n>      generator seed (default ${STAGING_DEFAULTS.seed})
  --today <date>  treat YYYY-MM-DD as today in IST
  --dry-run       write inside a transaction, print the counts, roll back

Refuses with APP_ENV=production, for any host but this machine unless SEED_TARGET=staging, and for a
database that holds clients it didn't create.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const target = checkTarget(process.env);
  if (!target.ok) throw new Refusal(target.reason);
  const today = args.today ?? todayIST();

  const db = new Client({ connectionString: target.url, application_name: "taxwise-seed-staging" });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local timezone = 'Asia/Kolkata'");
    // One run at a time per database.
    await db.query("select pg_advisory_xact_lock(hashtext('taxwise:seed-staging'))");
    const pre = await preflight(db);
    if (pre === "already_seeded") {
      await db.query("rollback");
      console.log(`${target.database} on ${target.host} already has its synthetic data. Nothing to do.`);
      return;
    }
    const plan = planStagingData({ clients: args.clients, seed: args.seed, today });
    const counts = await writePlan(db, plan, pre, createRandom(args.seed + 1));
    if (args.dryRun) await db.query("rollback");
    else await db.query("commit");
    console.log(`${args.dryRun ? "Dry run (rolled back)" : "Seeded"}: ${target.database} on ${target.host}, schema ${pre.schemaVersion}, today ${today}, seed ${args.seed}.`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v}`);
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

const invokedDirectly = typeof process !== "undefined" && /seed-staging\.(?:ts|js|mjs|cjs)$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Refusal ? err.message : `seed-staging failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
