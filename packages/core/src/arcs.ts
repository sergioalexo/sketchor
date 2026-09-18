import { dist, type Point } from "./geometry";

/**
 * Arc constructions for the arc tool (roadmap T-01) and the polyline arc
 * mode (T-03): the ways a person specifies an arc, resolved to the
 * `ArcEntity` parameters (center, radius, start/end angle, sweep
 * direction). Pure functions; the tool only collects the picks.
 *
 * Every constructor returns null for degenerate input (coincident points,
 * collinear three-point picks, a zero radius) rather than an arc with NaN
 * in it — a tool then simply keeps waiting for a usable pick.
 */

export interface ArcParams {
  center: Point;
  radius: number;
  /** Radians, as in `ArcEntity`. */
  startAngle: number;
  endAngle: number;
  ccw: boolean;
}

const EPS = 1e-9;

/**
 * The arc through three points: it starts at `start`, ends at `end`, and
 * passes through `via` — the Onshape / AutoCAD "3-point" arc, where the
 * third pick is a point *on* the arc, which also fixes which way round it
 * goes. Null when the three points are collinear (or two coincide).
 */
export function arcFrom3Points(start: Point, via: Point, end: Point): ArcParams | null {
  const ax = start.x;
  const ay = start.y;
  const bx = via.x;
  const by = via.y;
  const cx = end.x;
  const cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < EPS) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const center = { x: ux, y: uy };
  const radius = dist(center, start);
  if (radius < EPS) return null;
  const startAngle = Math.atan2(ay - uy, ax - ux);
  const endAngle = Math.atan2(cy - uy, cx - ux);
  // The sweep direction is the one that passes through `via`: the sign of
  // the cross product (start→via) × (via→end) says which way the path turns.
  const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
  return { center, radius, startAngle, endAngle, ccw: cross > 0 };
}

/**
 * An arc about `center` from `start` to the direction of `end`, going
 * counterclockwise unless told otherwise (AutoCAD's default; hold a
 * modifier to flip). The radius is fixed by `start`; `end` only supplies
 * the angle, as in AutoCAD's Center-Start-End, so the arc ends on the ray
 * center→end even if that point is not at the same radius.
 */
export function arcFromCenterStartEnd(center: Point, start: Point, end: Point, ccw = true): ArcParams | null {
  const radius = dist(center, start);
  if (radius < EPS || dist(center, end) < EPS) return null;
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  if (Math.abs(startAngle - endAngle) < EPS) return null;
  return { center, radius, startAngle, endAngle, ccw };
}

/**
 * The arc that starts at `start` tangent to `tangent` (a unit or non-unit
 * direction vector at the start) and ends at `end` — the Onshape "tangent
 * arc" that continues smoothly from the end of the previous line or arc.
 * Null when `end` lies on the tangent line (a straight continuation, no
 * arc) or coincides with `start`.
 */
export function tangentArc(start: Point, tangent: Point, end: Point): ArcParams | null {
  const tl = Math.hypot(tangent.x, tangent.y);
  const chord = dist(start, end);
  if (tl < EPS || chord < EPS) return null;
  const tx = tangent.x / tl;
  const ty = tangent.y / tl;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Which side of the tangent line the end point falls on decides the turn.
  const cross = tx * dy - ty * dx;
  if (Math.abs(cross) < EPS * Math.max(1, chord)) return null;
  // The center is along the normal to the tangent at `start`, at the
  // distance where start and end are equidistant from it:
  //   r = chord² / (2 · (chord ⊥ tangent))
  const radius = (chord * chord) / (2 * Math.abs(cross));
  const nx = cross > 0 ? -ty : ty;
  const ny = cross > 0 ? tx : -tx;
  const center = { x: start.x + nx * radius, y: start.y + ny * radius };
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  return { center, radius, startAngle, endAngle, ccw: cross > 0 };
}

/**
 * The DXF-style bulge of an arc segment from `a` to `b` that passes
 * through `via` — how the polyline tool stores an arc leg (T-03). Zero for
 * a straight segment (collinear or degenerate input).
 */
export function bulgeFrom3Points(a: Point, via: Point, b: Point): number {
  const arc = arcFrom3Points(a, via, b);
  if (!arc) return 0;
  // Included angle from the chord and radius; the sign follows the sweep.
  const chord = dist(a, b);
  const half = Math.min(1, chord / (2 * arc.radius));
  let theta = 2 * Math.asin(half);
  // A `via` on the far side of the chord means the major arc.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const toVia = (via.x - mx) * (arc.center.x - mx) + (via.y - my) * (arc.center.y - my);
  if (toVia > 0) theta = 2 * Math.PI - theta;
  const bulge = Math.tan(theta / 4);
  return arc.ccw ? bulge : -bulge;
}
