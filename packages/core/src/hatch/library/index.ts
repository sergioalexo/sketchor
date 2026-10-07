import type { PatternDef } from "../pat";
import { writePat } from "../pat";
import { registerPattern } from "../registry";
import { ANSI_PATTERNS } from "./ansi";
import { ARCHITECTURAL_PATTERNS } from "./architectural";
import { DIN_JIS_PATTERNS, GOST_PATTERNS } from "./gost";
import { GEOMETRIC_PATTERNS } from "./geometric";
import { ISO_LINE_PATTERNS, ISO_MATERIAL_PATTERNS } from "./iso";

/**
 * The built-in hatch pattern library (H-03), authored clean-room: every
 * definition is derived from the geometry it depicts (see each file's header),
 * not copied from AutoCAD's acad.pat / acadiso.pat or LibreCAD's pattern
 * files (plan §0.9). Names that other CAD programs exchange in DXF
 * (ANSI31, AR-CONC, ACAD_ISO02W100, …) are kept so a drawing hatched here
 * reads the same elsewhere; the numbers are our own.
 *
 * Importing this module registers every pattern for name lookup.
 */
export const BUILTIN_PATTERNS: readonly PatternDef[] = [
  ...ANSI_PATTERNS,
  ...ARCHITECTURAL_PATTERNS,
  ...ISO_LINE_PATTERNS,
  ...ISO_MATERIAL_PATTERNS,
  ...GOST_PATTERNS,
  ...DIN_JIS_PATTERNS,
  ...GEOMETRIC_PATTERNS,
];

for (const p of BUILTIN_PATTERNS) registerPattern(p);

/** Pattern categories in display order. */
export const PATTERN_CATEGORIES: readonly string[] = ["ANSI", "Architectural", "ISO 128 line types", "ISO 128 materials", "GOST 2.306", "DIN / JIS", "Geometric"];

/** The whole library as a `.pat` file, for export. */
export function builtinPatText(): string {
  return writePat(BUILTIN_PATTERNS);
}
