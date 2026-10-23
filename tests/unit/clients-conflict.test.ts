import { describe, expect, it } from "vitest";
import {
  classifyConflicts,
  conflictCheckRequired,
  describeDuplicate,
  duplicateBlocks,
  freezeConflicts,
  matchNames,
  nameTokens,
  normaliseName,
  panInGstin,
  parseRelatedParties,
  rationaleProblem,
  relatedIdentifiers,
  summariseConflicts,
  trigramSimilarity,
  type ConflictCandidate,
} from "@/lib/domain/conflict";

const candidate = (over: Partial<ConflictCandidate>): ConflictCandidate => ({
  kind: "client",
  recordId: "00000000-0000-4000-8000-000000000001",
  clientId: "00000000-0000-4000-8000-000000000001",
  leadId: null,
  label: "Sharma Traders",
  code: "TW-C-0042",
  pan: null,
  gstin: null,
  din: null,
  candidateName: "Sharma Traders",
  inRecycleBin: false,
  ...over,
});

describe("normaliseName (mirror of normalise_party_name, 0111)", () => {
  it("drops case, punctuation, M/s and legal-form words; reads & as and", () => {
    expect(normaliseName("M/s. Sharma & Co. Pvt. Ltd.")).toBe("sharma");
    expect(normaliseName("The Alpha Traders LLP")).toBe("alpha traders");
    expect(normaliseName("Sharma and Sons Private Limited")).toBe("sharma sons");
    expect(normaliseName("SHARMA & SONS")).toBe("sharma sons");
    expect(normaliseName("Gupta Brothers (OPC) Pvt Ltd")).toBe("gupta brothers");
  });
  it("keeps words that are part of a name, and digits", () => {
    expect(normaliseName("Co-operative Credit Society")).toBe("operative credit society");
    expect(normaliseName("Messrs 24x7 Logistics")).toBe("24x7 logistics");
    expect(normaliseName("Mohan Sweets")).toBe("mohan sweets");
  });
  it("is empty for nothing", () => {
    expect(normaliseName(null)).toBe("");
    expect(normaliseName("  ")).toBe("");
    expect(normaliseName("Pvt Ltd")).toBe("");
    expect(nameTokens("Alpha Beta Pvt Ltd")).toEqual(["alpha", "beta"]);
  });
});

describe("trigramSimilarity (pg_trgm similarity)", () => {
  it("is 1 for the same text and 0 for nothing in common", () => {
    expect(trigramSimilarity("sharma traders", "sharma traders")).toBe(1);
    expect(trigramSimilarity("abc", "xyz")).toBe(0);
    expect(trigramSimilarity("", "abc")).toBe(0);
  });
  it("matches pg_trgm on a known pair", () => {
    // pg_trgm: similarity('word', 'words') = 0.5714286 (4 shared of 7); 'sharma trader' ~ 'sharma traders' = 0.8125
    expect(trigramSimilarity("word", "words")).toBeCloseTo(4 / 7, 5);
    expect(trigramSimilarity("sharma trader", "sharma traders")).toBeCloseTo(0.8125, 4);
    expect(trigramSimilarity("alpha traders", "alpha industries")).toBeCloseTo(0.24, 2);
  });
});

describe("matchNames", () => {
  it("same when equal after normalising or with the words in another order", () => {
    expect(matchNames("Sharma Traders Pvt Ltd", "SHARMA TRADERS")).toEqual({ kind: "same", score: 1 });
    expect(matchNames("Traders Sharma", "Sharma Traders")).toEqual({ kind: "same", score: 1 });
  });
  it("similar for a typo or a missing letter, null for unrelated names", () => {
    const m = matchNames("Sharma Trader", "Sharma Traders");
    expect(m?.kind).toBeDefined();
    expect(m!.score).toBeGreaterThanOrEqual(0.6);
    expect(matchNames("Alpha Traders", "Beta Industries")).toBeNull();
    expect(matchNames("", "Beta")).toBeNull();
  });
});

describe("identifiers and related parties", () => {
  it("reads the PAN inside a GSTIN", () => {
    expect(panInGstin("29AAXFT1811B1Z3")).toBe("AAXFT1811B");
    expect(panInGstin("29AAXFT")).toBeNull();
  });
  it("cleans the related-party tags", () => {
    expect(parseRelatedParties(["  Ramesh  Gupta ", "ramesh gupta", "", "Gupta Holdings"])).toEqual(["Ramesh Gupta", "Gupta Holdings"]);
    expect(parseRelatedParties(Array.from({ length: 60 }, (_, i) => `Party ${i}`))).toHaveLength(50);
  });
  it("finds PANs and DINs typed as related parties", () => {
    expect(relatedIdentifiers(["ABCDE1234F", "01234567", "Ramesh"])).toEqual({ pans: ["ABCDE1234F"], dins: ["01234567"] });
  });
});

describe("classifyConflicts (§7.5.4: each hit with why it matched)", () => {
  it("an exact PAN match on a client is an exact hit", () => {
    const hits = classifyConflicts({ prospectName: "New Name", pan: "AAXFT1811B" }, [candidate({ pan: "AAXFT1811B", label: "Other Name" })]);
    expect(hits).toHaveLength(1);
    expect(hits[0].strength).toBe("exact");
    expect(hits[0].reasons.map((r) => r.code)).toContain("same_pan");
    expect(hits[0].title).toBe("Client Other Name (TW-C-0042)");
  });

  it("the PAN inside the prospect's GSTIN, and the same GSTIN, are exact too", () => {
    const hits = classifyConflicts({ prospectName: "X", gstin: "29AAXFT1811B1Z3" }, [
      candidate({ pan: "AAXFT1811B", gstin: "29AAXFT1811B1Z3", label: "Firm", candidateName: "Firm" }),
    ]);
    expect(hits[0].reasons.map((r) => r.code).sort()).toEqual(["pan_in_gstin", "same_gstin"]);
  });

  it("a normalised-name match is strong; a close one is possible; a weak one is dropped", () => {
    const hits = classifyConflicts({ prospectName: "M/s Sharma Traders Pvt Ltd" }, [
      candidate({ recordId: "a", label: "Sharma Traders" }),
      candidate({ recordId: "b", label: "Sharma Trader Co", candidateName: "Sharma Trader Co", code: "TW-C-0043" }),
      candidate({ recordId: "c", label: "Verma Steel", candidateName: "Verma Steel", code: "TW-C-0044" }),
    ]);
    expect(hits.map((h) => h.recordId)).toEqual(["a", "b"]);
    expect(hits[0].strength).toBe("strong");
    expect(hits[0].reasons[0].code).toBe("same_name");
    expect(hits[1].strength).toBe("possible");
    expect(hits[1].reasons[0].text).toBe('The name is close to "Sharma Trader Co" (81% alike).');
  });

  it("a related party who is a client's director (KYC) or contact is a related-party overlap", () => {
    const hits = classifyConflicts({ prospectName: "Gupta Foods", relatedParties: ["Ramesh Gupta", "01234567"] }, [
      candidate({ kind: "kyc_person", recordId: "k1", label: "Alpha Traders", code: "TW-C-0001", candidateName: "Ramesh Gupta" }),
      candidate({ kind: "kyc_person", recordId: "k2", label: "Beta Ltd", code: "TW-C-0002", candidateName: "Someone Else", din: "01234567" }),
      candidate({ kind: "contact", recordId: "c1", label: "Gamma LLP", code: "TW-C-0003", candidateName: "Ramesh Gupta" }),
    ]);
    const byId = Object.fromEntries(hits.map((h) => [h.recordId, h]));
    expect(byId.k1.reasons[0].code).toBe("related_party");
    expect(byId.k1.title).toBe("Ramesh Gupta, a director or partner of Alpha Traders (TW-C-0001)");
    expect(byId.k2.strength).toBe("exact");
    expect(byId.k2.reasons[0].text).toContain("DIN 01234567");
    expect(byId.c1.title).toBe("Ramesh Gupta, a contact of Gamma LLP (TW-C-0003)");
    // the exact DIN hit sorts first
    expect(hits[0].recordId).toBe("k2");
  });

  it("leads match on the company or the person's name", () => {
    const hits = classifyConflicts({ prospectName: "Gupta Foods" }, [
      candidate({ kind: "lead", recordId: "l1", label: "Gupta Foods", code: "L-0007", candidateName: "Anil Gupta", clientId: null, leadId: "l1" }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Lead Gupta Foods (L-0007)");
  });

  it("merges candidates for the same record and keeps the strongest", () => {
    const hits = classifyConflicts({ prospectName: "Sharma Traders", pan: "ABCDE1234F" }, [
      candidate({ recordId: "a", label: "Sharma Traders" }),
      candidate({ recordId: "a", label: "Sharma Traders", pan: "ABCDE1234F" }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].strength).toBe("exact");
    expect(hits[0].reasons.map((r) => r.code).sort()).toEqual(["same_name", "same_pan"]);
  });

  it("says when the matched client is in the recycle bin", () => {
    const [hit] = classifyConflicts({ prospectName: "Sharma Traders" }, [candidate({ inRecycleBin: true })]);
    expect(hit.title).toContain("in the recycle bin");
  });

  it("summarises and freezes", () => {
    const hits = classifyConflicts({ prospectName: "Sharma Traders", pan: "ABCDE1234F" }, [
      candidate({ recordId: "a", pan: "ABCDE1234F", label: "Zed", candidateName: "Zed" }),
      candidate({ recordId: "b", label: "Sharma Traders" }),
    ]);
    expect(summariseConflicts(hits)).toBe("1 exact match on PAN, GSTIN or DIN and 1 same name.");
    expect(summariseConflicts([])).toBe("No conflicts found.");
    const frozen = freezeConflicts(hits);
    expect(frozen[0]).toMatchObject({ kind: "client", record_id: "a", strength: "exact" });
    expect(frozen[0].reasons[0]).toContain("Same PAN");
  });
});

describe("the decision rules (§7.5.4)", () => {
  it("needs a rationale to decline, or to accept despite matches", () => {
    expect(rationaleProblem("declined", 0, "")).toBe("Give the reason for declining.");
    expect(rationaleProblem("declined", 0, "Conflict with an audit client")).toBeNull();
    expect(rationaleProblem("accepted", 2, " ")).toMatch(/despite the matches/);
    expect(rationaleProblem("accepted", 2, "Different entity, checked with the partner")).toBeNull();
    expect(rationaleProblem("accepted", 0, null)).toBeNull();
    expect(rationaleProblem("pending", 3, null)).toBeNull();
  });
  it("is mandatory for audit services", () => {
    expect(conflictCheckRequired(["gst", "audit"])).toBe(true);
    expect(conflictCheckRequired(["gst", "income_tax"])).toBe(false);
  });
});

describe("duplicate guard (§7.3.2)", () => {
  it("PAN and GSTIN duplicates block; a close name warns", () => {
    expect(duplicateBlocks({ matchedOn: "pan" })).toBe(true);
    expect(duplicateBlocks({ matchedOn: "gstin" })).toBe(true);
    expect(duplicateBlocks({ matchedOn: "name" })).toBe(false);
  });
  it("words the banner", () => {
    const d = describeDuplicate({ clientId: "x", clientCode: "TW-C-0042", displayName: "Sharma Traders", inRecycleBin: true, matchedOn: "name", score: 0.78 });
    expect(d.headline).toBe("This looks like Sharma Traders (TW-C-0042)");
    expect(d.detail).toBe("The name is 78% alike. It's in the recycle bin: a Partner or Manager can restore it.");
  });
});
