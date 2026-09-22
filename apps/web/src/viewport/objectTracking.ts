import type { Point } from "@sketchor/core";

/**
 * Object snap tracking (roadmap T-20) — AutoCAD's OTRACK, Onshape's
 * inference lines.
 *
 * Hovering a feature point *acquires* it. After that, whenever the cursor
 * lines up with an acquired point — horizontally, vertically, or along a
 * polar increment — the cursor is pulled onto that alignment and a dashed
 * guide is drawn back to the point it came from. Line up with two acquired
 * points at once and you get their intersection, which is the whole reason
 * the feature exists: "directly above this corner and level with that one"
 * is a position no snap can name, and it is where half of CAD geometry
 * actually goes.
 *
 * Pure, so the rules are testable without a canvas: the viewport supplies
 * the acquired points, the angles in play and the pixel tolerance in world
 * units, and gets back a point plus the guides to draw.
 */

export interface TrackRay {
  from: Point;
  angleDeg: number;
}

export interface TrackHit {
  point: Point;
  /** One ray per alignment that produced the point: one for a projection, two for an intersection. */
  rays: TrackRay[];
}

/** Below this, two alignments are too nearly parallel for their intersection to mean anything. */
const MIN_CROSS_SINE = 0.2;

/**
 * The tracked position for `cursor`, or null when nothing lines up.
 *
 * `angles` are the directions tracking is allowed to run in (degrees;
 * `[0, 90]` for ortho, multiples of the increment for polar). An alignment
 * counts when the cursor is within `tol` of the *infinite* line through the
 * acquired point — tracking works backwards from a corner as readily as
 * forwards, as it does in AutoCAD.
 */
export function trackAlignment(
  cursor: Point,
  acquired: readonly Point[],
  angles: readonly number[],
  tol: number,
): TrackHit | null {
  if (acquired.length === 0 || angles.length === 0 || tol <= 0) return null;

  type Candidate = { from: Point; angleDeg: number; ux: number; uy: number; d: number };
  const candidates: Candidate[] = [];
  for (const from of acquired) {
    // Standing on the point itself is not an alignment; the snap that
    // acquired it already covers that case.
    if (Math.hypot(cursor.x - from.x, cursor.y - from.y) < tol) continue;
    for (const angleDeg of angles) {
      const rad = (angleDeg * Math.PI) / 180;
      const ux = Math.cos(rad);
      const uy = Math.sin(rad);
      // Perpendicular distance to the infinite line through `from`.
      const d = Math.abs((cursor.x - from.x) * uy - (cursor.y - from.y) * ux);
      if (d <= tol) candidates.push({ from, angleDeg, ux, uy, d });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.d - b.d);

  // Two alignments crossing beats one, whenever the crossing is somewhere
  // the cursor actually is.
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      const cross = a.ux * b.uy - a.uy * b.ux;
      if (Math.abs(cross) < MIN_CROSS_SINE) continue;
      const t = ((b.from.x - a.from.x) * b.uy - (b.from.y - a.from.y) * b.ux) / cross;
      const point = { x: a.from.x + a.ux * t, y: a.from.y + a.uy * t };
      // Guard against a crossing that satisfies both lines but sits far
      // along them from the cursor (shallow angles, wide tolerance).
      if (Math.hypot(point.x - cursor.x, point.y - cursor.y) > (tol * 2) / Math.abs(cross)) continue;
      return {
        point,
        rays: [
          { from: a.from, angleDeg: a.angleDeg },
          { from: b.from, angleDeg: b.angleDeg },
        ],
      };
    }
  }

  const best = candidates[0];
  const along = (cursor.x - best.from.x) * best.ux + (cursor.y - best.from.y) * best.uy;
  return {
    point: { x: best.from.x + best.ux * along, y: best.from.y + best.uy * along },
    rays: [{ from: best.from, angleDeg: best.angleDeg }],
  };
}

/** The directions tracking may run in: ortho's four, or every multiple of a polar increment. */
export function trackingAngles(increment: number | null): number[] {
  const step = increment && increment > 0 ? increment : 90;
  const angles: number[] = [];
  for (let a = 0; a < 360; a += step) angles.push(a);
  return angles;
}

/**
 * Remembers a hovered feature point, newest first, capped at `limit`.
 * Re-hovering a point that is already acquired moves it to the front
 * rather than duplicating it, and acquiring is idempotent — the cursor
 * sits on a point for many move events before it leaves.
 */
export function acquirePoint(acquired: readonly Point[], p: Point, limit = 3, epsilon = 1e-9): Point[] {
  const rest = acquired.filter((q) => Math.hypot(q.x - p.x, q.y - p.y) > epsilon);
  return [p, ...rest].slice(0, limit);
}
