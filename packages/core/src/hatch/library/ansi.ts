import { fam, pat } from "./dsl";

/**
 * ANSI31–38 — the section-lining symbols of ASME Y14.2 / ANSI Z14 (iron,
 * steel, bronze, plastic/rubber, fire brick, marble/slate/glass, lead/zinc/
 * magnesium, aluminium). The standard fixes the idea (45° lines, a family per
 * material told apart by a second line weight or direction) but not numbers,
 * so the spacings and dashes here are this project's own.
 */
const C = { category: "ANSI" };

export const ANSI_PATTERNS = [
  pat("ANSI31", C, "General / cast iron — 45° lines", [fam(45, 3)]),
  pat("ANSI32", C, "Steel — 45° line pairs", [fam(45, 6), fam(45, 6, { shift: 1.3 })]),
  pat("ANSI33", C, "Bronze, brass, copper — 45° lines with a dashed line between", [fam(45, 6), fam(45, 6, { shift: 3, dashes: [4, -1.5] })]),
  pat("ANSI34", C, "Plastic, rubber — 45° line triples", [fam(45, 7), fam(45, 7, { shift: 1.2 }), fam(45, 7, { shift: 2.4 })]),
  pat("ANSI35", C, "Fire brick, refractory — 45° lines with dashed lines between", [fam(45, 3), fam(45, 3, { shift: 1.5, dashes: [3, -1.5] })]),
  pat("ANSI36", C, "Marble, slate, glass — 45° lines crossed by short strokes", [fam(45, 3), fam(135, 6, { dashes: [1.5, -4.5] })]),
  pat("ANSI37", C, "Lead, zinc, magnesium — crossed 45° lines", [fam(45, 3), fam(135, 3)]),
  pat("ANSI38", C, "Aluminium — 45° lines crossed by dashed lines", [fam(45, 3), fam(135, 3, { dashes: [3, -3] })]),
];
