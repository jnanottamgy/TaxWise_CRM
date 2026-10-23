/**
 * Client acceptance and the conflict check (§7.5.4, §6.8 "Independence and conflict check before
 * every attest engagement", §6.9 stage 1), and the duplicate guard's name matching (§7.3.2).
 *
 * The database finds candidates broadly (`conflict_candidates`, `find_client_duplicates`, 0111/0112,
 * pg_trgm similarity on `normalise_party_name`); this module decides which of them are real
 * matches and says why each one matched, in plain words:
 *   - exact PAN or GSTIN matches (and a PAN inside a GSTIN);
 *   - normalised-name matches: the same name once case, punctuation, "&"/"and" and legal-form words
 *     (Pvt, Ltd, LLP, M/s, Co …) are set aside, or a close name (trigram similarity);
 *   - related-party overlaps: a group company, director or partner of the prospect who is already a
 *     client, a lead, a client's contact, a client's director/partner (KYC), a related party of an
 *     earlier acceptance, or a client group.
 * It also holds the decision rules: a rationale is required when declining, or when accepting
 * despite a match (§7.5.4).
 *
 * `normaliseName` mirrors `public.normalise_party_name` (0111) and `trigramSimilarity` mirrors
 * pg_trgm's `similarity()`, so a threshold means the same thing on both sides.
 *
 * Pure and client-safe.
 */

// -------------------------------------------------------------------------------------------------
// Names
// -------------------------------------------------------------------------------------------------

/** Words left out when comparing names (legal forms and joiners). Mirror of the list in 0111. */
export const NAME_STOP_WORDS: readonly string[] = [
  "the",
  "and",
  "of",
  "messrs",
  "private",
  "pvt",
  "limited",
  "ltd",
  "llp",
  "plc",
  "inc",
  "opc",
  "co",
  "company",
  "corp",
  "corporation",
];

const STOP = new Set(NAME_STOP_WORDS);

/**
 * The name used for matching (mirror of `public.normalise_party_name`): lower case; "M/s" dropped;
 * "&" read as "and"; anything that isn't a letter or digit becomes a space; legal-form words and
 * joiners removed. `"M/s. Sharma & Co. Pvt. Ltd."` → `"sharma"`. Empty string when nothing is left.
 */
export function normaliseName(input: string | null | undefined): string {
  if (!input) return "";
  const text = input
    .toLowerCase()
    .replace(/(^|[^a-z0-9])m\s*\/\s*s(\.|[^a-z0-9]|$)/g, "$1 $2")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!text) return "";
  return text
    .split(/\s+/)
    .filter((t) => t !== "" && !STOP.has(t))
    .join(" ");
}

/** The words of a normalised name. */
export function nameTokens(input: string | null | undefined): string[] {
  const n = normaliseName(input);
  return n ? n.split(" ") : [];
}

/** pg_trgm's trigrams of a string: each word padded with two spaces before and one after. */
export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * Trigram similarity of two strings, as pg_trgm's `similarity()` computes it: shared trigrams over
 * all distinct trigrams (0 to 1). Two empty strings are 0.
 */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export type NameMatch = { kind: "same" | "similar"; score: number };

/** Thresholds for name matches (trigram similarity on normalised names). */
export const NAME_MATCH = {
  /** At or above this, the names are treated as the same (allowing a typo or a missing word). */
  same: 0.85,
  /** At or above this, a close name worth showing (the duplicate guard's 0.6, 0111). */
  similar: 0.6,
} as const;

/**
 * Whether two names match once normalised: `same` when they are equal, have the same words in any
 * order, or are nearly identical (≥ 0.85); `similar` from 0.6; otherwise null.
 */
export function matchNames(a: string | null | undefined, b: string | null | undefined, thresholds = NAME_MATCH): NameMatch | null {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return null;
  if (na === nb) return { kind: "same", score: 1 };
  const sa = [...new Set(na.split(" "))].sort().join(" ");
  const sb = [...new Set(nb.split(" "))].sort().join(" ");
  if (sa === sb) return { kind: "same", score: 1 };
  const score = Math.round(trigramSimilarity(na, nb) * 1000) / 1000;
  if (score >= thresholds.same) return { kind: "same", score };
  if (score >= thresholds.similar) return { kind: "similar", score };
  return null;
}

// -------------------------------------------------------------------------------------------------
// Identifiers
// -------------------------------------------------------------------------------------------------

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const DIN_RE = /^[0-9]{8}$/;

function ident(v: string | null | undefined): string | null {
  const s = (v ?? "").replace(/\s+/g, "").toUpperCase();
  return s ? s : null;
}

/** The PAN inside a 15-character GSTIN (characters 3–12), or null. */
export function panInGstin(gstin: string | null | undefined): string | null {
  const g = ident(gstin);
  if (!g || g.length !== 15) return null;
  const pan = g.slice(2, 12);
  return PAN_RE.test(pan) ? pan : null;
}

/**
 * Related parties as entered in the tag input (§7.5.4: group companies, directors, partners):
 * trimmed, blanks dropped, duplicates (ignoring case and spacing) removed, at most 50 of up to 120
 * characters each.
 */
export function parseRelatedParties(tags: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    const t = raw.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

/** PANs and DINs typed as related parties (a director's DIN, a group company's PAN). */
export function relatedIdentifiers(parties: readonly string[]): { pans: string[]; dins: string[] } {
  const pans: string[] = [];
  const dins: string[] = [];
  for (const p of parties) {
    const v = ident(p);
    if (!v) continue;
    if (PAN_RE.test(v) && !pans.includes(v)) pans.push(v);
    else if (DIN_RE.test(v) && !dins.includes(v)) dins.push(v);
  }
  return { pans, dins };
}

// -------------------------------------------------------------------------------------------------
// Candidates and hits
// -------------------------------------------------------------------------------------------------

export const CONFLICT_KINDS = ["client", "lead", "contact", "kyc_person", "acceptance_party", "group"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/** A row from `conflict_candidates` (0112), camel-cased. */
export type ConflictCandidate = {
  kind: ConflictKind;
  recordId: string;
  clientId: string | null;
  leadId: string | null;
  /** The client's name (for client, contact and KYC rows), the lead's name, the earlier prospect, the group. */
  label: string;
  /** Client code or lead number. */
  code: string | null;
  pan: string | null;
  gstin: string | null;
  din: string | null;
  /** The name that matched: the contact, the director, the related party, the lead. */
  candidateName: string | null;
  inRecycleBin: boolean;
};

export type ConflictInput = {
  prospectName: string;
  pan?: string | null;
  gstin?: string | null;
  relatedParties?: readonly string[];
};

export type ConflictReasonCode =
  | "same_pan"
  | "same_gstin"
  | "pan_in_gstin"
  | "related_identifier"
  | "same_name"
  | "similar_name"
  | "related_party";

export type ConflictReason = { code: ConflictReasonCode; text: string };

/** How strong a hit is: an identifier, the same name, or a close name. */
export type ConflictStrength = "exact" | "strong" | "possible";

export type ConflictHit = {
  /** `${kind}:${recordId}`. */
  key: string;
  kind: ConflictKind;
  recordId: string;
  clientId: string | null;
  leadId: string | null;
  /** What it is, in a few words: "Client Sharma Traders (TW-C-0042)". */
  title: string;
  reasons: ConflictReason[];
  strength: ConflictStrength;
  inRecycleBin: boolean;
};

const KIND_ORDER: Record<ConflictKind, number> = { client: 0, kyc_person: 1, contact: 2, lead: 3, acceptance_party: 4, group: 5 };
const STRENGTH_ORDER: Record<ConflictStrength, number> = { exact: 0, strong: 1, possible: 2 };

function withCode(label: string, code: string | null): string {
  return code ? `${label} (${code})` : label;
}

function titleOf(c: ConflictCandidate): string {
  switch (c.kind) {
    case "client":
      return `Client ${withCode(c.label, c.code)}${c.inRecycleBin ? ", in the recycle bin" : ""}`;
    case "lead":
      return `Lead ${withCode(c.label, c.code)}`;
    case "contact":
      return `${c.candidateName ?? "A contact"}, a contact of ${withCode(c.label, c.code)}`;
    case "kyc_person":
      return `${c.candidateName ?? "A director or partner"}, a director or partner of ${withCode(c.label, c.code)}`;
    case "acceptance_party":
      return `${c.candidateName ?? "A related party"}, a related party of ${c.label} (an earlier conflict check)`;
    case "group":
      return `Client group ${c.label}`;
  }
}

type Target = { raw: string; isProspect: boolean };

function bestNameMatch(name: string | null | undefined, targets: readonly Target[]): { target: Target; match: NameMatch } | null {
  let best: { target: Target; match: NameMatch } | null = null;
  for (const t of targets) {
    const m = matchNames(name, t.raw);
    if (!m) continue;
    const better =
      !best ||
      (m.kind === "same" && best.match.kind !== "same") ||
      (m.kind === best.match.kind && (m.score > best.match.score || (m.score === best.match.score && t.isProspect && !best.target.isProspect)));
    if (better) best = { target: t, match: m };
  }
  return best;
}

function nameReason(c: ConflictCandidate, name: string, found: { target: Target; match: NameMatch }): ConflictReason {
  const pct = `${Math.round(found.match.score * 100)}%`;
  if (found.target.isProspect) {
    const what =
      c.kind === "contact"
        ? `The prospect's name matches this contact`
        : c.kind === "kyc_person"
          ? `The prospect's name matches this director or partner`
          : c.kind === "acceptance_party"
            ? `The prospect was named as a related party in this earlier check`
            : `The name ${found.match.kind === "same" ? "is the same as" : "is close to"} "${name}"`;
    return found.match.kind === "same"
      ? { code: "same_name", text: `${what}.` }
      : { code: "similar_name", text: `${what} (${pct} alike).` };
  }
  const how = found.match.kind === "same" ? "matches" : `is close to (${pct} alike)`;
  return { code: "related_party", text: `Related party "${found.target.raw}" ${how} "${name}".` };
}

/**
 * Turns database candidates into conflict hits with their reasons (§7.5.4 "shows each hit with
 * why it matched"). A candidate with no reason (a weak name match the database let through) is
 * dropped; candidates for the same record are merged. Sorted: identifier matches first, then same
 * names, then close names; within a strength, clients before KYC people, contacts, leads, earlier
 * related parties and groups.
 */
export function classifyConflicts(input: ConflictInput, candidates: readonly ConflictCandidate[]): ConflictHit[] {
  const prospect = input.prospectName.trim();
  const pan = ident(input.pan);
  const gstin = ident(input.gstin);
  const gstinPan = panInGstin(gstin);
  const parties = parseRelatedParties(input.relatedParties);
  const ids = relatedIdentifiers(parties);
  const targets: Target[] = [
    ...(prospect ? [{ raw: prospect, isProspect: true }] : []),
    ...parties.filter((p) => !ids.pans.includes(ident(p) ?? "") && !ids.dins.includes(ident(p) ?? "")).map((p) => ({ raw: p, isProspect: false })),
  ];

  const byKey = new Map<string, ConflictHit>();
  for (const c of candidates) {
    const reasons: ConflictReason[] = [];
    const cPan = ident(c.pan);
    const cGstin = ident(c.gstin);
    const cDin = ident(c.din);
    let exact = false;

    if (c.kind === "client" || c.kind === "acceptance_party") {
      if (pan && cPan === pan) {
        reasons.push({ code: "same_pan", text: `Same PAN (${pan}).` });
        exact = true;
      } else if (gstinPan && cPan === gstinPan) {
        reasons.push({ code: "pan_in_gstin", text: `Their PAN ${cPan} is inside the GSTIN entered.` });
        exact = true;
      } else if (pan && cGstin && panInGstin(cGstin) === pan) {
        reasons.push({ code: "pan_in_gstin", text: `Their GSTIN ${cGstin} contains this PAN.` });
        exact = true;
      }
      if (gstin && cGstin === gstin) {
        reasons.push({ code: "same_gstin", text: `Same GSTIN (${gstin}).` });
        exact = true;
      }
      if (cPan && ids.pans.includes(cPan)) {
        reasons.push({ code: "related_identifier", text: `Related party PAN ${cPan} is theirs.` });
        exact = true;
      }
    }
    if (c.kind === "kyc_person") {
      if (cPan && (ids.pans.includes(cPan) || cPan === pan)) {
        reasons.push({ code: "related_identifier", text: `PAN ${cPan} ${cPan === pan ? "is the prospect's" : "was entered as a related party"}.` });
        exact = true;
      }
      if (cDin && ids.dins.includes(cDin)) {
        reasons.push({ code: "related_identifier", text: `DIN ${cDin} was entered as a related party.` });
        exact = true;
      }
    }

    // Clients and leads match on their own name (or the legal name / company the database matched);
    // contacts, directors and earlier related parties on the person's or party's name.
    const names =
      c.kind === "client" || c.kind === "lead"
        ? [c.label, c.candidateName]
        : c.kind === "group"
          ? [c.label]
          : [c.candidateName ?? c.label];
    let found: { target: Target; match: NameMatch } | null = null;
    let matchedName = "";
    for (const n of names) {
      if (!n) continue;
      const m = bestNameMatch(n, targets);
      if (m && (!found || m.match.score > found.match.score || (m.match.kind === "same" && found.match.kind !== "same"))) {
        found = m;
        matchedName = n;
      }
    }
    if (found) reasons.push(nameReason(c, matchedName, found));

    if (reasons.length === 0) continue;
    const strength: ConflictStrength = exact ? "exact" : reasons.some((r) => r.code === "same_name" || (r.code === "related_party" && found?.match.kind === "same")) ? "strong" : "possible";
    const key = `${c.kind}:${c.recordId}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const r of reasons) if (!existing.reasons.some((e) => e.text === r.text)) existing.reasons.push(r);
      if (STRENGTH_ORDER[strength] < STRENGTH_ORDER[existing.strength]) existing.strength = strength;
      continue;
    }
    byKey.set(key, {
      key,
      kind: c.kind,
      recordId: c.recordId,
      clientId: c.clientId,
      leadId: c.leadId,
      title: titleOf(c),
      reasons,
      strength,
      inRecycleBin: c.inRecycleBin,
    });
  }

  return [...byKey.values()].sort(
    (a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title),
  );
}

/** "No conflicts found." / "2 exact matches and 1 close name." */
export function summariseConflicts(hits: readonly ConflictHit[]): string {
  if (hits.length === 0) return "No conflicts found.";
  const exact = hits.filter((h) => h.strength === "exact").length;
  const strong = hits.filter((h) => h.strength === "strong").length;
  const possible = hits.length - exact - strong;
  const parts = [
    exact ? `${exact} exact ${exact === 1 ? "match" : "matches"} on PAN, GSTIN or DIN` : null,
    strong ? `${strong} same ${strong === 1 ? "name" : "names"}` : null,
    possible ? `${possible} close ${possible === 1 ? "name" : "names"}` : null,
  ].filter((p): p is string => p !== null);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// -------------------------------------------------------------------------------------------------
// The decision (§7.5.4)
// -------------------------------------------------------------------------------------------------

export const ACCEPTANCE_DECISIONS = ["accepted", "declined", "pending"] as const;
export type AcceptanceDecision = (typeof ACCEPTANCE_DECISIONS)[number];

export const ACCEPTANCE_DECISION_LABELS: Record<AcceptanceDecision, string> = {
  accepted: "Accept",
  declined: "Decline",
  pending: "Pending",
};

/** Services that are attest work: the conflict check is mandatory before onboarding (§7.3.2, §6.8). */
export const ATTEST_SERVICE_TYPES: readonly string[] = ["audit"];

/** True when the selected services need a conflict check with the decision Accept. */
export function conflictCheckRequired(serviceTypes: readonly string[]): boolean {
  return serviceTypes.some((s) => ATTEST_SERVICE_TYPES.includes(s));
}

/**
 * The rationale rule (§7.5.4): required when declining, or when accepting despite a conflict.
 * Pending needs none. Returns null when the decision may be recorded, else the sentence to show.
 */
export function rationaleProblem(decision: AcceptanceDecision, hitCount: number, rationale: string | null | undefined): string | null {
  const has = (rationale ?? "").trim().length > 0;
  if (decision === "declined" && !has) return "Give the reason for declining.";
  if (decision === "accepted" && hitCount > 0 && !has) return "Explain why you are accepting despite the matches the check found.";
  return null;
}

/** What is frozen in `client_acceptances.conflicts_found` at decision time. */
export type FrozenConflict = {
  kind: ConflictKind;
  record_id: string;
  client_id: string | null;
  lead_id: string | null;
  title: string;
  strength: ConflictStrength;
  reasons: string[];
};

export function freezeConflicts(hits: readonly ConflictHit[]): FrozenConflict[] {
  return hits.map((h) => ({
    kind: h.kind,
    record_id: h.recordId,
    client_id: h.clientId,
    lead_id: h.leadId,
    title: h.title,
    strength: h.strength,
    reasons: h.reasons.map((r) => r.text),
  }));
}

// -------------------------------------------------------------------------------------------------
// Duplicate guard (§7.3.2)
// -------------------------------------------------------------------------------------------------

export type DuplicateMatch = "pan" | "gstin" | "name";

/** A row from `find_client_duplicates` (0111), camel-cased. */
export type DuplicateCandidate = {
  clientId: string;
  clientCode: string;
  displayName: string;
  inRecycleBin: boolean;
  matchedOn: DuplicateMatch;
  score: number;
};

/**
 * Whether a duplicate stops onboarding: the same PAN or GSTIN can't be saved twice (both are
 * unique, recycled clients included), so the only ways on are to open the existing client or
 * restore it. A close name is a warning: a Partner or Manager may continue with a reason.
 */
export function duplicateBlocks(d: Pick<DuplicateCandidate, "matchedOn">): boolean {
  return d.matchedOn === "pan" || d.matchedOn === "gstin";
}

/** "This looks like Sharma Traders (TW-C-0042)" and why (§7.3.2). */
export function describeDuplicate(d: DuplicateCandidate): { headline: string; detail: string } {
  const headline = `This looks like ${d.displayName} (${d.clientCode})`;
  const where = d.inRecycleBin ? " It's in the recycle bin: a Partner or Manager can restore it." : "";
  switch (d.matchedOn) {
    case "pan":
      return { headline, detail: `It has the same PAN, and a PAN can belong to only one client.${where}` };
    case "gstin":
      return { headline, detail: `It has the same GSTIN, and a GSTIN can belong to only one client.${where}` };
    case "name":
      return { headline, detail: `The name is ${Math.round(d.score * 100)}% alike.${where}` };
  }
}
