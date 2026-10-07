import type { PatternFamily } from "../../entities";
import { fam } from "./dsl";

/**
 * Lattice constructions shared by several patterns, each derived on paper:
 * the line family of a regular tiling is a set of parallel lines whose dash
 * phase advances by a constant (`stagger`) from one line to the next.
 */

const S60 = Math.sqrt(3) / 2;

/**
 * Horizontal zigzag rows, every segment `a` long at ±60°, rows `a·√3` apart.
 * The 60° segments of every row lie on one family of lines (spacing a·√3/2)
 * whose dash start moves −a/2 per line; the 120° segments are the mirror
 * image about x = a/2 and move +a/2.
 */
export function zigzag(a: number): PatternFamily[] {
  const p = a * S60;
  return [
    fam(60, p, { stagger: -a / 2, dashes: [a, -a] }),
    // origin (a, 0) in the 120° line's own frame: u = (-1/2, √3/2), n = (-√3/2, -1/2)
    fam(120, p, { phase: -a / 2, shift: -a * S60, stagger: a / 2, dashes: [a, -a] }),
  ];
}

/**
 * Flat-top hexagons of side `a`: the horizontal edges sit on lines `a·√3/2`
 * apart, `a` long every 3a, shifted 1.5a per line; the other two edge
 * directions are the same family turned 60° and 120° about a hexagon centre.
 */
export function honeycomb(a: number): PatternFamily[] {
  const h = a * S60;
  return [0, 60, 120].map((angle) => fam(angle, h, { phase: a, stagger: 1.5 * a, dashes: [a, -2 * a] }));
}

/** Equilateral-triangle tiling of side `s`: three line families through common lattice points. */
export function triangles(s: number): PatternFamily[] {
  const h = s * S60;
  return [fam(0, h), fam(60, h), fam(120, h)];
}

/**
 * Checkerboard of `sq`-sized squares, the dark ones filled with lines `gap`
 * apart. Each column strip of lines is its own family so the along-line phase
 * can alternate every `sq`.
 */
export function checker(sq: number, gap: number): PatternFamily[] {
  const out: PatternFamily[] = [];
  const n = Math.max(1, Math.round(sq / gap));
  for (let m = 0; m < n; m++) {
    // vertical lines x = 2·sq·q + m·gap inside even columns: filled in even rows
    out.push(fam(90, 2 * sq, { shift: -m * gap, dashes: [sq, -sq] }));
    // odd columns: x = sq + 2·sq·q + m·gap, filled in odd rows
    out.push(fam(90, 2 * sq, { shift: -(sq + m * gap), phase: sq, dashes: [sq, -sq] }));
  }
  return out;
}
