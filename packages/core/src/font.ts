import type { Point } from "./geometry";

/**
 * A minimal single-stroke ("engraving") vector font: uppercase A-Z, digits,
 * and common punctuation, each drawn as a handful of line/arc strokes in a
 * unit em box (x: 0..0.7 advance width, y: 0..1 cap height, baseline at 0).
 *
 * This is what DXF TEXT/MTEXT import falls back to (see dxf.ts) so imported
 * lettering renders as ordinary line geometry — selectable, editable, no new
 * entity type or font dependency needed. Lowercase input is upper-cased.
 */

function arcPts(cx: number, cy: number, rx: number, ry: number, a0Deg: number, a1Deg: number, steps = 10): Point[] {
  const a0 = (a0Deg * Math.PI) / 180;
  const a1 = (a1Deg * Math.PI) / 180;
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + (a1 - a0) * (i / steps);
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return pts;
}

const W = 0.7; // advance width for most glyphs

/** Each glyph is a list of strokes (pen-up between strokes); coordinates are unit-em. */
const GLYPHS: Record<string, Point[][]> = {
  A: [
    [{ x: 0, y: 0 }, { x: 0.35, y: 1 }, { x: 0.7, y: 0 }],
    [{ x: 0.15, y: 0.4 }, { x: 0.55, y: 0.4 }],
  ],
  B: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }],
    arcPts(0, 0.75, 0.32, 0.25, 90, -90),
    arcPts(0, 0.25, 0.36, 0.25, 90, -90),
  ],
  C: [arcPts(0.4, 0.5, 0.35, 0.45, 45, 315, 12)],
  D: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }],
    arcPts(0, 0.5, 0.45, 0.5, 90, -90, 12),
  ],
  E: [
    [{ x: 0.6, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0.6, y: 0 }],
    [{ x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }],
  ],
  F: [
    [{ x: 0.6, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }],
    [{ x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }],
  ],
  G: [
    arcPts(0.4, 0.5, 0.35, 0.45, 60, 340, 12),
    [{ x: 0.7, y: 0.42 }, { x: 0.4, y: 0.42 }, { x: 0.4, y: 0.5 }],
  ],
  H: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }],
    [{ x: 0.6, y: 0 }, { x: 0.6, y: 1 }],
    [{ x: 0, y: 0.5 }, { x: 0.6, y: 0.5 }],
  ],
  I: [[{ x: 0.3, y: 0 }, { x: 0.3, y: 1 }]],
  J: [
    [{ x: 0.6, y: 1 }, { x: 0.6, y: 0.25 }],
    arcPts(0.35, 0.25, 0.25, 0.25, 0, -180, 8),
  ],
  K: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }],
    [{ x: 0.6, y: 1 }, { x: 0, y: 0.5 }],
    [{ x: 0, y: 0.5 }, { x: 0.6, y: 0 }],
  ],
  L: [[{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0.6, y: 0 }]],
  M: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0.35, y: 0.4 }, { x: 0.7, y: 1 }, { x: 0.7, y: 0 }],
  ],
  N: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0.6, y: 0 }, { x: 0.6, y: 1 }],
  ],
  O: [arcPts(0.35, 0.5, 0.35, 0.5, 0, 360, 16)],
  P: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }],
    arcPts(0, 0.75, 0.35, 0.25, 90, -90, 10),
  ],
  Q: [
    arcPts(0.35, 0.5, 0.35, 0.5, 0, 360, 16),
    [{ x: 0.45, y: 0.15 }, { x: 0.75, y: -0.05 }],
  ],
  R: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }],
    arcPts(0, 0.75, 0.35, 0.25, 90, -90, 10),
    [{ x: 0.1, y: 0.5 }, { x: 0.6, y: 0 }],
  ],
  S: [
    arcPts(0.38, 0.76, 0.28, 0.22, 200, -20, 10),
    arcPts(0.32, 0.24, 0.28, 0.22, 160, 380, 10),
  ],
  T: [
    [{ x: 0, y: 1 }, { x: 0.7, y: 1 }],
    [{ x: 0.35, y: 1 }, { x: 0.35, y: 0 }],
  ],
  U: [
    [{ x: 0, y: 1 }, { x: 0, y: 0.3 }],
    arcPts(0.35, 0.3, 0.35, 0.3, 180, 360, 10),
    [{ x: 0.7, y: 0.3 }, { x: 0.7, y: 1 }],
  ],
  V: [[{ x: 0, y: 1 }, { x: 0.35, y: 0 }, { x: 0.7, y: 1 }]],
  W: [
    [{ x: 0, y: 1 }, { x: 0.17, y: 0 }, { x: 0.35, y: 0.6 }, { x: 0.53, y: 0 }, { x: 0.7, y: 1 }],
  ],
  X: [
    [{ x: 0, y: 0 }, { x: 0.6, y: 1 }],
    [{ x: 0, y: 1 }, { x: 0.6, y: 0 }],
  ],
  Y: [
    [{ x: 0, y: 1 }, { x: 0.35, y: 0.5 }, { x: 0.7, y: 1 }],
    [{ x: 0.35, y: 0.5 }, { x: 0.35, y: 0 }],
  ],
  Z: [
    [{ x: 0, y: 1 }, { x: 0.6, y: 1 }, { x: 0, y: 0 }, { x: 0.6, y: 0 }],
  ],
  "0": [
    arcPts(0.35, 0.5, 0.32, 0.48, 0, 360, 14),
    [{ x: 0.15, y: 0.2 }, { x: 0.55, y: 0.8 }],
  ],
  "1": [
    [{ x: 0.1, y: 0.75 }, { x: 0.35, y: 1 }, { x: 0.35, y: 0 }],
    [{ x: 0.12, y: 0 }, { x: 0.58, y: 0 }],
  ],
  "2": [
    arcPts(0.35, 0.72, 0.32, 0.26, 200, -20, 10),
    [{ x: 0.6, y: 0.46 }, { x: 0, y: 0 }, { x: 0.65, y: 0 }],
  ],
  "3": [
    arcPts(0.32, 0.76, 0.3, 0.22, -80, 100, 8),
    arcPts(0.32, 0.24, 0.3, 0.22, -100, 100, 8),
  ],
  "4": [
    [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 0.3 }, { x: 0.65, y: 0.3 }],
  ],
  "5": [
    [{ x: 0.6, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0.55 }],
    arcPts(0.3, 0.3, 0.3, 0.25, 90, -260, 10),
  ],
  "6": [
    arcPts(0.4, 0.8, 0.3, 0.25, 90, 220, 8),
    arcPts(0.35, 0.28, 0.32, 0.28, 0, 360, 14),
  ],
  "7": [
    [{ x: 0, y: 1 }, { x: 0.65, y: 1 }, { x: 0.2, y: 0 }],
  ],
  "8": [
    arcPts(0.35, 0.75, 0.28, 0.24, 0, 360, 12),
    arcPts(0.35, 0.26, 0.32, 0.26, 0, 360, 12),
  ],
  "9": [
    arcPts(0.35, 0.72, 0.32, 0.28, 0, 360, 14),
    arcPts(0.3, 0.2, 0.3, 0.25, -90, 40, 8),
  ],
  ".": [[{ x: 0.28, y: 0 }, { x: 0.32, y: 0 }]],
  ",": [[{ x: 0.32, y: 0.05 }, { x: 0.24, y: -0.12 }]],
  "-": [[{ x: 0.1, y: 0.45 }, { x: 0.5, y: 0.45 }]],
  ":": [[{ x: 0.3, y: 0.15 }, { x: 0.3, y: 0.18 }], [{ x: 0.3, y: 0.65 }, { x: 0.3, y: 0.68 }]],
  "/": [[{ x: 0, y: 0 }, { x: 0.5, y: 1 }]],
  "'": [[{ x: 0.3, y: 0.85 }, { x: 0.34, y: 1 }]],
  "(": [arcPts(0.55, 0.5, 0.35, 0.55, 110, 250, 8)],
  ")": [arcPts(0.1, 0.5, 0.35, 0.55, -70, 70, 8)],
  "#": [
    [{ x: 0.1, y: 0 }, { x: 0.25, y: 1 }],
    [{ x: 0.4, y: 0 }, { x: 0.55, y: 1 }],
    [{ x: 0, y: 0.3 }, { x: 0.6, y: 0.3 }],
    [{ x: 0, y: 0.7 }, { x: 0.6, y: 0.7 }],
  ],
  "+": [
    [{ x: 0.05, y: 0.45 }, { x: 0.55, y: 0.45 }],
    [{ x: 0.3, y: 0.2 }, { x: 0.3, y: 0.7 }],
  ],
  _: [[{ x: 0, y: -0.05 }, { x: 0.6, y: -0.05 }]],
};

const SPACE_WIDTH = 0.55;

/**
 * Lowers `text` to strokes for a DXF TEXT/MTEXT entity: unit-em glyph
 * polylines scaled by `height`, advanced left-to-right, rotated by
 * `rotationRad` about `insertion`, and translated so the baseline starts
 * there. Unknown characters are skipped (not every DXF glyph has a stroke).
 */
export function textToStrokes(
  text: string,
  insertion: Point,
  height: number,
  rotationRad: number,
): Point[][] {
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const place = (local: Point): Point => {
    const x = local.x * height;
    const y = local.y * height;
    return { x: insertion.x + x * cos - y * sin, y: insertion.y + x * sin + y * cos };
  };

  const strokes: Point[][] = [];
  let advance = 0;
  for (const raw of text) {
    const ch = raw.toUpperCase();
    if (ch === " " || ch === "\t") {
      advance += SPACE_WIDTH;
      continue;
    }
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (const stroke of glyph) {
        strokes.push(stroke.map((p) => place({ x: p.x + advance, y: p.y })));
      }
    }
    advance += W + 0.12;
  }
  return strokes;
}
