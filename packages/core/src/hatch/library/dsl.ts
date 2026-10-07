import type { PatternFamily } from "../../entities";
import type { PatternDef } from "../pat";

/**
 * Authoring helpers for the built-in pattern library (H-03). Every pattern in
 * `library/*.ts` is written here from the geometry of the thing it depicts
 * (a brick bond, an ISO 128 line type, a lattice) — not transcribed from any
 * existing `.pat` file (plan §0.9). Units are millimetres at scale 1.
 */

const rad = (d: number): number => (d * Math.PI) / 180;
const r5 = (n: number): number => Math.round(n * 1e5) / 1e5 + 0;

export interface LineOpts {
  /** Perpendicular shift of line 0 from the pattern origin (mm). */
  shift?: number;
  /** Along-line position where the dash cycle of line 0 starts (mm). */
  phase?: number;
  /** Along-line shift added for each successive line (the `.pat` `dx`). */
  stagger?: number;
  /** Alternating pen-down (+) / gap (-) lengths; 0 = a dot. Absent = continuous. */
  dashes?: number[];
}

/** A family of parallel lines `spacing` apart at `angle` degrees. */
export function fam(angle: number, spacing: number, o: LineOpts = {}): PatternFamily {
  const a = rad(angle);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const shift = o.shift ?? 0;
  const phase = o.phase ?? 0;
  return {
    angle,
    origin: { x: r5(c * phase - s * shift), y: r5(s * phase + c * shift) },
    offset: { x: r5(o.stagger ?? 0), y: r5(spacing) },
    dashes: (o.dashes ?? []).map(r5),
  };
}

/** A lattice of dots: `dx` apart along rows `dy` apart, alternate rows offset by `rowShift`, at `angle`. */
export function dots(angle: number, dx: number, dy: number, o: { rowShift?: number; shift?: number; phase?: number } = {}): PatternFamily {
  return fam(angle, dy, { stagger: o.rowShift ?? 0, shift: o.shift, phase: o.phase, dashes: [0, -dx] });
}

export interface LibraryMeta {
  category: string;
  /** Default hatch scale for a drawing in millimetres (patterns are authored in mm). */
  mm?: number;
}

const INCH = 25.4;

export function pat(name: string, meta: LibraryMeta, description: string, families: PatternFamily[]): PatternDef {
  const mm = meta.mm ?? 1;
  return { name, description, category: meta.category, families, defaultScale: { mm, inch: r5(mm / INCH) } };
}
