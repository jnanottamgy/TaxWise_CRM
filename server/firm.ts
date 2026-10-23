import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@/lib/database.types";
import { FIRM_DEFAULTS } from "@/lib/auth/firm-defaults";
import { stateName } from "@/lib/domain/india-validators";
import { log } from "@/lib/log";

/**
 * The firm as emails, PDFs, the portal and the public quotation page show it (§1, §4.6, §11).
 *
 *   const firm = await getFirmProfile(supabase);          // any client: anon, a user, the service role
 *   const settings = await getFirmSettings(supabase);     // staff session or the service role only
 *
 * getFirmProfile reads through public_firm_profile() (security definer, public by design), which
 * exposes only the public subset: name, address, GSTIN, phone, email, website, logo, bank and UPI.
 * It never throws for a missing row: it falls back to the §1 identity and logs, so a PDF or email
 * still carries the right letterhead. A database error is thrown (the caller's block shows its Ref).
 *
 * getFirmSettings returns the whole firm_settings row (RLS: staff and the service role). It is not
 * lib/data/settings.ts getFirmSettings, which shapes the row for the Settings pages.
 */

/** The §3.1 palette as hex for emails and PDFs, where CSS variables don't exist (light theme). */
export const BRAND = {
  navy: "#14284B",
  primary: "#1F4FD8",
  primarySoft: "#EAF0FF",
  gold: "#B8892E",
  goldText: "#8A6420",
  bg: "#F6F7FB",
  surface: "#FFFFFF",
  surface2: "#F1F3F8",
  border: "#E4E7EE",
  text: "#0F172A",
  textMuted: "#5B6476",
  successText: "#047857",
  warningText: "#8F5A02",
  dangerText: "#B42318",
  warningSoft: "#FDF3E1",
  dangerSoft: "#FDECEA",
} as const;

/** The product credit on every email and PDF (§0). */
export const POWERED_BY = "Powered by J-TACS";

export interface FirmBank {
  name: string | null;
  accountName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  branch: string | null;
}

export interface FirmUpi {
  id: string;
  payeeName: string;
}

export interface FirmProfile {
  firmName: string;
  legalName: string | null;
  tagline: string | null;
  /** Street address (without city, state and PIN). */
  address: string | null;
  city: string | null;
  stateCode: string;
  stateName: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  gstin: string | null;
  logoPath: string | null;
  /** Public URL of the logo in the branding bucket, with a cache-buster; null without a logo. */
  logoUrl: string | null;
  /** Null when no bank detail is filled in. */
  bank: FirmBank | null;
  /** Null without a UPI ID. */
  upi: FirmUpi | null;
}

export type FirmSettings = Tables<"firm_settings">;

type AnySupabase = SupabaseClient<Database>;

type PublicProfileRow = Database["public"]["Functions"]["public_firm_profile"]["Returns"][number];

const blank = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** The logo's public URL (the branding bucket is public-read for the logo only, §2.3). */
export function firmLogoUrl(supabase: AnySupabase, logoPath: string | null, updatedAt: string | null): string | null {
  const raw = logoPath?.trim();
  if (!raw) return null;
  const path = raw.replace(/^\/+/, "").replace(/^branding\//, "");
  const { data } = supabase.storage.from("branding").getPublicUrl(path);
  if (!data?.publicUrl) return null;
  const version = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(version) ? `${data.publicUrl}?v=${version}` : data.publicUrl;
}

/** The §1 identity, for when the settings row is missing (the seed hasn't run). */
export function defaultFirmProfile(): FirmProfile {
  return {
    firmName: FIRM_DEFAULTS.firmName,
    legalName: null,
    tagline: FIRM_DEFAULTS.tagline,
    address: FIRM_DEFAULTS.address,
    city: FIRM_DEFAULTS.city,
    stateCode: FIRM_DEFAULTS.stateCode,
    stateName: stateName(FIRM_DEFAULTS.stateCode),
    pincode: FIRM_DEFAULTS.pincode,
    phone: FIRM_DEFAULTS.phone,
    email: FIRM_DEFAULTS.firmEmail,
    website: FIRM_DEFAULTS.website,
    gstin: FIRM_DEFAULTS.gstin,
    logoPath: null,
    logoUrl: null,
    bank: null,
    upi: null,
  };
}

/** Shapes a public_firm_profile() row. Exported for tests. */
export function toFirmProfile(row: PublicProfileRow, logoUrl: string | null): FirmProfile {
  const stateCode = blank(row.state_code) ?? FIRM_DEFAULTS.stateCode;
  const bank: FirmBank = {
    name: blank(row.bank_name),
    accountName: blank(row.bank_account_name),
    accountNumber: blank(row.bank_account_number),
    ifsc: blank(row.bank_ifsc),
    branch: blank(row.bank_branch),
  };
  const hasBank = Object.values(bank).some((v) => v !== null);
  const upiId = blank(row.upi_id);
  const firmName = blank(row.firm_name) ?? FIRM_DEFAULTS.firmName;
  return {
    firmName,
    legalName: blank(row.legal_name),
    tagline: blank(row.tagline),
    address: blank(row.address),
    city: blank(row.city),
    stateCode,
    stateName: stateName(stateCode),
    pincode: blank(row.pincode),
    phone: blank(row.phone),
    email: blank(row.email),
    website: blank(row.website),
    gstin: blank(row.gstin),
    logoPath: blank(row.logo_path),
    logoUrl,
    bank: hasBank ? bank : null,
    upi: upiId ? { id: upiId, payeeName: blank(row.upi_payee_name) ?? blank(row.legal_name) ?? firmName } : null,
  };
}

/** The public subset of the firm's settings (§4.6). Works for anon, signed-in users and the service role. */
export async function getFirmProfile(supabase: AnySupabase): Promise<FirmProfile> {
  const { data, error } = await supabase.rpc("public_firm_profile");
  if (error) throw Object.assign(new Error(error.message || "public_firm_profile failed"), error);
  const row = (data ?? [])[0];
  if (!row) {
    log("warn", "firm_settings row missing: using the §1 identity", { source: "server:firm" });
    return defaultFirmProfile();
  }
  return toFirmProfile(row, firmLogoUrl(supabase, row.logo_path, row.logo_updated_at));
}

/** The whole firm_settings row, or null when the seed hasn't run. Staff sessions and the service role only (RLS). */
export async function getFirmSettings(supabase: AnySupabase): Promise<FirmSettings | null> {
  const { data, error } = await supabase.from("firm_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw Object.assign(new Error(error.message || "firm_settings read failed"), error);
  return data ?? null;
}

/** "307, 14th Main Rd, Raj Mahal Vilas Extension, Sadashiva Nagar, Bengaluru, Karnataka 560080". */
export function formatFirmAddress(firm: Pick<FirmProfile, "address" | "city" | "stateName" | "pincode">): string {
  const statePin = [firm.stateName, firm.pincode].filter(Boolean).join(" ");
  return [firm.address, firm.city, statePin].filter((p) => p && p.trim()).join(", ");
}

/** The website without the scheme and trailing slash: "www.twchartered.com". */
export function displayWebsite(url: string | null | undefined): string | null {
  const t = url?.trim();
  if (!t) return null;
  return t.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}
