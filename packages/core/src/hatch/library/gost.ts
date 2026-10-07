import { dots, fam, pat } from "./dsl";
import { zigzag } from "./lattices";

/**
 * GOST 2.306 (ЕСКД) graphic symbols for materials in section, plus the DIN
 * 201 / JIS Z 8316 basics. The standards give the *idea* of each symbol (metal
 * = 45° lines, non-metal = lines crossed, wood = grain strokes, soil = short
 * ticks, liquid = horizontal lines, …) but no numeric definitions, so the
 * spacings here are this project's own, chosen to read at 1:1 in millimetres.
 */
const G = { category: "GOST 2.306" };
const D = { category: "DIN / JIS" };

export const GOST_PATTERNS = [
  pat("GOST-METAL", G, "Metals and hard alloys — 45° lines (ГОСТ 2.306)", [fam(45, 3)]),
  pat("GOST-NONMETAL", G, "Non-metallic materials — crossed 45° lines", [fam(45, 3), fam(135, 3)]),
  pat("GOST-WOOD", G, "Wood — grain strokes with end-grain ticks", [
    fam(0, 3, { dashes: [16, -3, 7, -4, 12, -2], stagger: 5.3 }),
    fam(80, 14, { dashes: [2, -12], stagger: 5, shift: 2 }),
  ]),
  pat("GOST-STONE", G, "Natural stone — dashed crossed lines", [fam(45, 6, { dashes: [8, -3] }), fam(135, 6, { shift: 3, dashes: [8, -3] })]),
  pat("GOST-CONCRETE", G, "Concrete — dots and slivers", [dots(0, 9, 7), dots(40, 11, 10, { shift: 3 }), fam(65, 24, { dashes: [3, -21], stagger: 9, shift: 2 })]),
  pat("GOST-REINFORCED", G, "Reinforced concrete — dots with 45° lines", [fam(45, 6), dots(0, 8, 6, { rowShift: 4 })]),
  pat("GOST-GLASS", G, "Glass — dashed 45° line pairs", [fam(45, 6, { dashes: [8, -3] }), fam(45, 6, { shift: 1.5, dashes: [8, -3] })]),
  pat("GOST-LIQUID", G, "Liquids — horizontal broken lines", [fam(0, 3, { dashes: [9, -2, 4, -2], stagger: 4 })]),
  pat("GOST-SOIL", G, "Natural soil — short horizontal ticks", [fam(0, 4, { dashes: [3, -4], stagger: 3.5 })]),
  pat("GOST-BRICK", G, "Brickwork — 45° lines with cross ticks", [fam(45, 4), fam(135, 8, { dashes: [2, -6] })]),
  pat("GOST-INSULATION", G, "Insulation — zigzag", zigzag(3)),
  pat("GOST-SAND", G, "Sand, loose fill — dots", [dots(0, 5, 4, { rowShift: 2.5 })]),
];

export const DIN_JIS_PATTERNS = [
  pat("DIN-FERROUS", D, "DIN 201 ferrous metals — 45° lines", [fam(45, 3)]),
  pat("DIN-NONFERROUS", D, "DIN 201 non-ferrous metals — 45° line and a dashed line", [fam(45, 6), fam(45, 6, { shift: 3, dashes: [5, -2] })]),
  pat("JIS-SECTION", D, "JIS Z 8316 section — 45° lines, close pairs", [fam(45, 4), fam(45, 4, { shift: 0.9 })]),
];
