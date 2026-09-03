import type { Point } from "./geometry";

/**
 * Linear-dimension *geometry*. Sketchor has no dimension entity — the tool (and
 * plugins) build a dimension from ordinary lines plus a {@link text} entity for
 * the label, grouped together. This module is the pure layout: given the two
 * measured points and an offset, it returns the extension lines, the dimension
 * line with its end ticks, and where/how the label should sit. The caller
 * formats the label string (it owns the display unit).
 */

export interface LinearDimensionOptions {
  /** Perpendicular distance from the a–b line to the dimension line, world units. Sign picks the side. */
  offset: number;
  /** Cap height for the label, world units. */
  textHeight: number;
  /** The already-formatted label (e.g. "1 200 mm"). */
  label: string;
}

export interface LinearDimension {
  /** Polyline point-pairs: two extension lines, the dimension line, two ticks. */
  lines: Point[][];
  /** The label: baseline start, string, height and rotation (radians, CCW). */
  text: { at: Point; text: string; height: number; rotation: number };
}

const TICK = 0.9; // tick half-length as a multiple of textHeight
const GAP = 0.4; // extension-line gap from the measured point, × textHeight
const EXT = 1.2; // extension past the dimension line, × textHeight

export function linearDimension(a: Point, b: Point, opts: LinearDimensionOptions): LinearDimension {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Unit direction along a→b and the left-hand normal.
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const off = opts.offset;
  const h = opts.textHeight;

  const shift = (p: Point, along: number, perp: number): Point => ({
    x: p.x + ux * along + nx * perp,
    y: p.y + uy * along + ny * perp,
  });

  const a1 = shift(a, 0, Math.sign(off) * GAP * h);
  const a2 = shift(a, 0, off + Math.sign(off) * EXT * h);
  const b1 = shift(b, 0, Math.sign(off) * GAP * h);
  const b2 = shift(b, 0, off + Math.sign(off) * EXT * h);
  const da = shift(a, 0, off);
  const db = shift(b, 0, off);

  const tick = (p: Point): Point[] => [shift(p, -TICK * h, -TICK * h * Math.sign(off) + off), shift(p, TICK * h, TICK * h * Math.sign(off) + off)];

  const lines: Point[][] = [
    [a1, a2],
    [b1, b2],
    [da, db],
    tick(a),
    tick(b),
  ];

  // Label centred on the dimension line, a little clear of it, reading along a→b.
  let rotation = Math.atan2(dy, dx);
  if (rotation > Math.PI / 2 || rotation < -Math.PI / 2) rotation += Math.PI; // keep it upright
  const mid = { x: (da.x + db.x) / 2, y: (da.y + db.y) / 2 };
  const textW = opts.label.length * h * 0.55;
  const cs = Math.cos(rotation);
  const sn = Math.sin(rotation);
  const at = {
    x: mid.x - (cs * textW) / 2 + nx * GAP * h,
    y: mid.y - (sn * textW) / 2 + ny * GAP * h,
  };

  return { lines, text: { at, text: opts.label, height: h, rotation } };
}
