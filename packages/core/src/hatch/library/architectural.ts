import { dots, fam, pat } from "./dsl";

/**
 * AR-* — architectural material hatches, drawn at real size in millimetres
 * (a standard brick is 215 × 65 with 10 mm joints, so a course is 75 and a
 * stretcher 225). Joints are broken vertical lines whose dash phase is what
 * makes a bond; the "random" patterns use incommensurate spacings so the
 * repeat is far larger than any one hatch region.
 */
const C = { category: "Architectural" };

/** Plank-strip parquet: 3 strips per square of side 3·w, squares alternating direction. */
function parquet(w: number) {
  const sq = 3 * w;
  const out = [];
  for (let m = 0; m < 3; m++) {
    // horizontal strips in squares where column ≡ row (mod 2): per line the dash start moves one square
    out.push(fam(0, sq, { shift: m * w, stagger: sq, dashes: [sq, -sq] }));
    // vertical strips where column ≢ row (mod 2)
    out.push(fam(90, sq, { shift: -m * w, phase: sq, stagger: sq, dashes: [sq, -sq] }));
  }
  return out;
}

export const ARCHITECTURAL_PATTERNS = [
  pat("AR-B816", C, "Concrete block 200 × 400, running bond", [
    fam(0, 200),
    fam(90, 400, { dashes: [200, -200] }),
    fam(90, 400, { shift: 200, phase: 200, dashes: [200, -200] }),
  ]),
  pat("AR-B88", C, "Concrete block 200 × 200, running bond", [
    fam(0, 200),
    fam(90, 200, { dashes: [200, -200] }),
    fam(90, 200, { shift: 100, phase: 200, dashes: [200, -200] }),
  ]),
  pat("AR-BRSTD", C, "Standard brick, running bond", [
    fam(0, 75),
    fam(90, 225, { dashes: [75, -75] }),
    fam(90, 225, { shift: 112.5, phase: 75, dashes: [75, -75] }),
  ]),
  pat("AR-BRELM", C, "Brick, English bond — a stretcher course, then a header course", [
    fam(0, 75),
    fam(90, 225, { dashes: [75, -75] }),
    fam(90, 112.5, { shift: 56.25, phase: 75, dashes: [75, -75] }),
  ]),
  pat("AR-CONC", C, "Concrete — scattered dots and slivers", [
    dots(0, 23, 17),
    dots(37, 19, 29, { shift: 6 }),
    dots(101, 31, 41, { shift: 11, phase: 5 }),
    fam(71, 53, { dashes: [4, -38], stagger: 17, shift: 3 }),
    fam(143, 47, { dashes: [3, -44], stagger: 23, shift: 9 }),
  ]),
  pat("AR-SAND", C, "Sand — fine scattered dots", [dots(0, 13, 11), dots(53, 19, 17, { shift: 4 }), dots(107, 23, 23, { phase: 7 })]),
  // Herringbone dominoes (w × 2w, w = 50): the tiling repeats under (w, w) and (2w, -2w); every horizontal
  // and every vertical line is drawn for 3w of each 4w, the break moving w per line. Hatch angle 45° gives the classic view.
  pat("AR-HBONE", C, "Herringbone — 50 × 100 planks (set the hatch angle to 45° for the classic view)", [
    fam(0, 50, { phase: -50, stagger: 50, dashes: [150, -50] }),
    fam(90, 50, { stagger: -50, dashes: [150, -50] }),
  ]),
  pat("AR-PARQ1", C, "Parquet — 50 mm strips in alternating 150 mm squares", parquet(50)),
  pat("AR-ROOF", C, "Roof shingles — courses with staggered butt joints", [
    fam(0, 100),
    fam(90, 150, { dashes: [100, -100] }),
    fam(90, 150, { shift: 75, phase: 100, dashes: [100, -100] }),
  ]),
  pat("AR-RROOF", C, "Random roof — irregular courses of shingles", [
    fam(0, 120, { dashes: [310, -6, 190, -4, 260, -8], stagger: 97 }),
    fam(90, 170, { dashes: [120, -120], stagger: 0 }),
    fam(90, 230, { shift: 40, phase: 120, dashes: [120, -120] }),
  ]),
  pat("AR-RSHKE", C, "Random wood shakes — irregular widths and courses", [
    fam(0, 150),
    fam(90, 120, { dashes: [150, -150], stagger: 0 }),
    fam(90, 180, { shift: 30, phase: 150, dashes: [150, -150] }),
    fam(90, 310, { shift: 77, phase: 40, dashes: [60, -240] }),
  ]),
];
