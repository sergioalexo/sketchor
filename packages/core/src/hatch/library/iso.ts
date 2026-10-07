import { dots, fam, pat } from "./dsl";
import { zigzag } from "./lattices";

/**
 * ISO 128. Part 24 defines the line types (dash 12d, gap 3d, long dash 24d, dot
 * ≈ 0, …, d = line width) — used here as hatch line types with d = 1 mm, under
 * the names exchanged in DXF files (ACAD_ISO02W100 … 15). Part 50 defines the
 * section-lining conventions for materials; the drawings are this project's.
 */
const LT = { category: "ISO 128 line types" };
const MAT = { category: "ISO 128 materials" };
const SPACE = 6;

const type = (n: string, description: string, dashes: number[]) =>
  pat(`ACAD_ISO${n}W100`, LT, `ISO 128-24 ${description}`, [fam(0, SPACE, { dashes })]);

export const ISO_LINE_PATTERNS = [
  type("02", "dashed line", [12, -3]),
  type("03", "dashed spaced line", [12, -18]),
  type("04", "long-dash dot line", [24, -3, 0, -3]),
  type("05", "long-dash double-dot line", [24, -3, 0, -3, 0, -3]),
  type("06", "long-dash triple-dot line", [24, -3, 0, -3, 0, -3, 0, -3]),
  type("07", "dotted line", [0, -3]),
  type("08", "long-dash short-dash line", [24, -3, 6, -3]),
  type("09", "long-dash double-short-dash line", [24, -3, 6, -3, 6, -3]),
  type("10", "dash dot line", [12, -3, 0, -3]),
  type("11", "double-dash dot line", [12, -3, 12, -3, 0, -3]),
  type("12", "dash double-dot line", [12, -3, 0, -3, 0, -3]),
  type("13", "double-dash double-dot line", [12, -3, 12, -3, 0, -3, 0, -3]),
  type("14", "dash triple-dot line", [12, -3, 0, -3, 0, -3, 0, -3]),
  type("15", "double-dash triple-dot line", [12, -3, 12, -3, 0, -3, 0, -3, 0, -3]),
];

export const ISO_MATERIAL_PATTERNS = [
  pat("ISO-GENERAL", MAT, "General section lining — 45° lines", [fam(45, 3)]),
  pat("ISO-METAL", MAT, "Metals — 45° line pairs", [fam(45, 6), fam(45, 6, { shift: 1.5 })]),
  pat("ISO-INSULATION", MAT, "Thermal / sound insulation — zigzag", zigzag(4)),
  pat("ISO-EARTH", MAT, "Earth — ground line with slanted strokes under it", [fam(0, 9), fam(45, 4.5, { shift: 1, dashes: [2.2, -6.8] })]),
  pat("ISO-GRAVEL", MAT, "Gravel, rubble — scattered dots and strokes", [
    dots(0, 7, 6),
    dots(0, 9, 6, { shift: 3, phase: 2 }),
    fam(70, 12, { dashes: [2.5, -9.5], stagger: 3.1 }),
    fam(160, 14, { dashes: [2, -12], stagger: 5.3, shift: 2 }),
  ]),
  pat("ISO-WATER", MAT, "Water, liquids — horizontal broken lines", [fam(0, 2.5, { dashes: [11, -2.5], stagger: 5.5 })]),
  pat("ISO-WOOD-ACROSS", MAT, "Wood across the grain — growth-ring strokes", [
    fam(0, 3, { dashes: [5, -1.5, 2, -3], stagger: 1.3 }),
    fam(12, 5.5, { dashes: [3, -4.5], stagger: 2.2 }),
    fam(168, 6.5, { dashes: [2.5, -5.5], stagger: 3.4 }),
  ]),
  pat("ISO-WOOD-ALONG", MAT, "Wood along the grain — long irregular strokes", [
    fam(0, 3, { dashes: [21, -3, 9, -4, 14, -2], stagger: 6.1 }),
    fam(0, 3, { shift: 1.5, dashes: [8, -5, 17, -3], stagger: 3.7 }),
  ]),
  pat("ISO-GLASS", MAT, "Glass — dashed 45° line pairs", [fam(45, 8, { dashes: [10, -4] }), fam(45, 8, { shift: 1.6, dashes: [10, -4] })]),
  pat("ISO-RUBBER", MAT, "Rubber, plastics — dense 45° lines", [fam(45, 2)]),
  pat("ISO-PLASTIC", MAT, "Plastics — 45° lines with a dotted line between", [fam(45, 3), fam(45, 3, { shift: 1.5, dashes: [0, -3] })]),
];
