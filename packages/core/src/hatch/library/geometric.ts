import { dots, fam, pat } from "./dsl";
import { checker, honeycomb, triangles, zigzag } from "./lattices";

/** Plain geometric fills. */
const C = { category: "Geometric" };

export const GEOMETRIC_PATTERNS = [
  pat("LINES", C, "Horizontal lines", [fam(0, 3)]),
  pat("LINES-45", C, "Diagonal lines", [fam(45, 3)]),
  pat("LINES-DASH", C, "Dashed diagonal lines", [fam(45, 3, { dashes: [3, -1.5] })]),
  pat("GRID", C, "Square grid", [fam(0, 5), fam(90, 5)]),
  pat("GRID-FINE", C, "Fine square grid", [fam(0, 3), fam(90, 3)]),
  pat("NET", C, "Diamond net", [fam(45, 4), fam(135, 4)]),
  pat("CROSS", C, "Plus marks on a square lattice", [fam(0, 10, { phase: -1.5, dashes: [3, -7] }), fam(90, 10, { phase: -1.5, dashes: [3, -7] })]),
  pat("DOTS", C, "Dot grid", [dots(0, 4, 4)]),
  pat("DOTS-DENSE", C, "Dense dot grid", [dots(0, 2.5, 2.5)]),
  pat("DOTS-STAGGER", C, "Staggered dots", [dots(0, 4, 3.4641, { rowShift: 2 })]),
  pat("BOXES", C, "Small squares", [
    fam(0, 8, { dashes: [4, -4] }),
    fam(0, 8, { shift: 4, dashes: [4, -4] }),
    fam(90, 8, { dashes: [4, -4] }),
    fam(90, 8, { shift: -4, dashes: [4, -4] }),
  ]),
  pat("HONEYCOMB", C, "Hexagons, 3 mm side", honeycomb(3)),
  pat("TRIANGLES", C, "Equilateral triangles, 5 mm side", triangles(5)),
  pat("ZIGZAG", C, "Horizontal zigzag rows", zigzag(4)),
  pat("CHECKER", C, "Checkerboard, 5 mm squares, dark squares lined", checker(5, 1)),
  pat("STARS", C, "Eight-point asterisks on a square lattice", [
    fam(0, 8, { phase: -1.5, dashes: [3, -5] }),
    fam(90, 8, { phase: -1.5, dashes: [3, -5] }),
    // diagonals through the lattice points: lines 8/√2 apart, a point every 8·√2 along each
    fam(45, 5.65685, { phase: -1.5, stagger: 5.65685, dashes: [3, -8.31371] }),
    fam(135, 5.65685, { phase: -1.5, stagger: 5.65685, dashes: [3, -8.31371] }),
  ]),
  pat("ESCHER", C, "Interlocking chevron bands", [...zigzag(5), ...zigzag(5).map((f) => ({ ...f, origin: { x: f.origin.x + 0, y: f.origin.y + 4.33 } }))]),
];
