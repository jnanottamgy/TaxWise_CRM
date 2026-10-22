/**
 * The firm's identity from §1, used to pre-fill the first-run form when `firm_settings` has no row
 * yet (normally the seed has already written it, and the form shows the stored values instead).
 */
export const FIRM_DEFAULTS = {
  firmName: "TaxWise Consultants",
  tagline: "Chartered Accountants · Bengaluru",
  address: "307, 14th Main Rd, Raj Mahal Vilas Extension, Sadashiva Nagar",
  city: "Bengaluru",
  stateCode: "29",
  pincode: "560080",
  phone: "+91 97405 40239",
  firmEmail: "info@twchartered.com",
  website: "https://www.twchartered.com/",
  gstin: "29AAXFT1811B1Z3",
  pan: "AAXFT1811B",
} as const;

export type FirmDetails = { -readonly [K in keyof typeof FIRM_DEFAULTS]: string };
