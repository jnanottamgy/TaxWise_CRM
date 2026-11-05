import { describe, expect, it } from "vitest";
import { LOGO } from "@/lib/brand";

/** The x, y pairs of an absolute M/L/C/Z path. */
function points(d: string): Array<[number, number]> {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
}

describe("the built-in logo (lib/brand.ts)", () => {
  it("uses only absolute M, L, C and Z, so the browser and the PDF renderer draw it alike", () => {
    for (const d of [...LOGO.shield, ...LOGO.wordmark]) {
      expect(d).toMatch(/^M/);
      expect(d.replace(/[MLCZ]|-?\d+(?:\.\d+)?|\s/g, "")).toBe("");
      // Every command has whole coordinate pairs (M and L one pair, C three).
      for (const seg of d.match(/[MLC][^MLCZ]*/g) ?? []) {
        const count = (seg.match(/-?\d+(?:\.\d+)?/g) ?? []).length;
        expect(count).toBe(seg[0] === "C" ? 6 : 2);
      }
    }
  });

  it("keeps the shield, its rim included, inside the mark's box", () => {
    const half = LOGO.rim / 2;
    for (const d of LOGO.shield) {
      for (const [x, y] of points(d)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(LOGO.mark.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(LOGO.mark.height - half);
      }
    }
  });

  it("sets the wordmark beside the shield, inside the lockup's box", () => {
    const xs = LOGO.wordmark.flatMap((d) => points(d).map(([x]) => x));
    const ys = LOGO.wordmark.flatMap((d) => points(d).map(([, y]) => y));
    expect(Math.min(...xs)).toBeGreaterThan(LOGO.mark.width);
    expect(Math.max(...xs)).toBeLessThanOrEqual(LOGO.lockup.width);
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThan(LOGO.lockup.height);
    expect(LOGO.lockup.height).toBe(LOGO.mark.height);
  });
});
