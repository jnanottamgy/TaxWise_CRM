"""Subsets Inter's static TTFs for PDF embedding (server/pdf/fonts/inter-*.ts).

- Source: the Inter 4.1 release (https://github.com/rsms/inter/releases/tag/v4.1), extras/ttf/
  Inter-Regular, -Medium, -SemiBold and -Bold (SIL Open Font License 1.1, see OFL.txt).
- Keeps Latin, Latin-1, Latin Extended-A, general punctuation, the rupee sign and a few symbols.
- Freezes tabular figures (the `tnum` feature) into the ten digits, so amounts line up in columns.
- Maps tab, line feed and carriage return to an empty zero-width glyph, so text with line breaks
  never falls back to another font.
- Drops hinting (PDFs don't use it).

Usage (fontTools 4.55): python -I subset-inter.py <src_dir> <out_dir>
Then wrap each <out_dir>/inter-<weight>.b64 as server/pdf/fonts/inter-<weight>.ts.
"""
import base64
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools import subset

WEIGHTS = {400: "Inter-Regular.ttf", 500: "Inter-Medium.ttf", 600: "Inter-SemiBold.ttf", 700: "Inter-Bold.ttf"}

RANGES = [
    (0x0020, 0x007E), (0x00A0, 0x00FF), (0x0100, 0x017F),
    (0x02C6, 0x02C6), (0x02DA, 0x02DA), (0x02DC, 0x02DC),
    (0x2010, 0x2027), (0x2030, 0x2030), (0x2032, 0x2033), (0x2039, 0x203A),
    (0x20AC, 0x20AC), (0x20B9, 0x20B9), (0x2116, 0x2116), (0x2122, 0x2122),
    (0x2190, 0x2193), (0x2212, 0x2212), (0x2248, 0x2248), (0x2260, 0x2260), (0x2264, 0x2265),
    (0x2713, 0x2713), (0x25CF, 0x25CF), (0xFFFD, 0xFFFD),
]


def single_subst_map(font, feature_tag):
    gsub = font["GSUB"].table
    lookups = set()
    for rec in gsub.FeatureList.FeatureRecord:
        if rec.FeatureTag == feature_tag:
            lookups.update(rec.Feature.LookupListIndex)
    mapping = {}
    for idx in sorted(lookups):
        lookup = gsub.LookupList.Lookup[idx]
        for st in lookup.SubTable:
            if lookup.LookupType == 7:
                st = st.ExtSubTable
            if getattr(st, "mapping", None):
                mapping.update(st.mapping)
    return mapping


def add_line_break_glyph(font):
    """An empty, zero-width glyph for U+0009, U+000A and U+000D."""
    from fontTools.ttLib.tables._g_l_y_f import Glyph

    name = "uni000A"
    order = font.getGlyphOrder()
    if name not in order:
        font["glyf"].glyphs[name] = Glyph()
        font["hmtx"].metrics[name] = (0, 0)
        font.setGlyphOrder(order + [name])
        font["glyf"].glyphOrder = font.getGlyphOrder()
        font["maxp"].numGlyphs = len(font.getGlyphOrder())
    for table in font["cmap"].tables:
        if table.isUnicode():
            for cp in (0x09, 0x0A, 0x0D):
                table.cmap[cp] = name


def main(src_dir, out_dir):
    src_dir, out_dir = Path(src_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    unicodes = [cp for lo, hi in RANGES for cp in range(lo, hi + 1)]
    for weight, name in WEIGHTS.items():
        font = TTFont(src_dir / name)
        tnum = single_subst_map(font, "tnum")
        # Freeze tabular figures for the ten digits: amounts line up in PDF columns.
        for table in font["cmap"].tables:
            if not table.isUnicode():
                continue
            for cp in range(0x30, 0x3A):
                g = table.cmap.get(cp)
                if g and g in tnum:
                    table.cmap[cp] = tnum[g]
        opts = subset.Options()
        opts.layout_features = ["kern", "liga", "calt", "ccmp", "locl", "mark", "mkmk", "case"]
        opts.hinting = False
        opts.name_IDs = ["*"]
        opts.name_languages = ["*"]
        opts.notdef_outline = True
        opts.glyph_names = False
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=unicodes)
        sub.subset(font)
        add_line_break_glyph(font)
        out = out_dir / f"inter-{weight}.ttf"
        font.save(out)
        data = out.read_bytes()
        b64 = base64.b64encode(data).decode("ascii")
        (out_dir / f"inter-{weight}.b64").write_text(b64)
        digits = [font.getBestCmap().get(cp) for cp in range(0x30, 0x3A)]
        widths = {font["hmtx"][g][0] for g in digits}
        print(name, "->", out.name, len(data), "bytes; digit advance widths", sorted(widths), "rupee", font.getBestCmap().get(0x20B9))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
