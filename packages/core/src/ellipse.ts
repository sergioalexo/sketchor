import type { EllipseEntity } from "./entities";
import type { Point } from "./geometry";
import type { Bounds } from "./dxf";

/**
 * Ellipse geometry (C-01). An ellipse is `center + major·cos t + minor·sin t`
 * where `minor` is `major` turned +90° and scaled by `ratio` — so a mirror
 * has to flip the parameter direction, which {@link transformEllipse} does.
 * Pure functions; the entity kind in `kinds/ellipseKind.ts` wires them in.
 */

const TAU = Math.PI * 2;

export type EllipseGeom = Pick<EllipseEntity, "center" | "majorAxis" | "ratio" | "start" | "end">;

export const minorAxisOf = (e: EllipseGeom): Point => ({ x: -e.majorAxis.y * e.ratio, y: e.majorAxis.x * e.ratio });

/** Radians swept counterclockwise from `start` to `end`; a full turn when they coincide or span ≥ 2π. */
export function ellipseSweep(e: Pick<EllipseGeom, "start" | "end">): number {
  const raw = e.end - e.start;
  if (raw >= TAU - 1e-9) return TAU;
  const s = ((raw % TAU) + TAU) % TAU;
  return s < 1e-12 ? TAU : s;
}

export const isFullEllipse = (e: Pick<EllipseGeom, "start" | "end">): boolean => ellipseSweep(e) >= TAU - 1e-9;

export function ellipsePointAt(e: EllipseGeom, t: number): Point {
  const n = minorAxisOf(e);
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: e.center.x + e.majorAxis.x * c + n.x * s, y: e.center.y + e.majorAxis.y * c + n.y * s };
}

/** First derivative with respect to the parameter. */
export function ellipseTangentAt(e: EllipseGeom, t: number): Point {
  const n = minorAxisOf(e);
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: -e.majorAxis.x * s + n.x * c, y: -e.majorAxis.y * s + n.y * c };
}

/** Whether parameter `t` lies on the swept range (any 2π-multiple counts). */
export function ellipseHasParam(e: Pick<EllipseGeom, "start" | "end">, t: number): boolean {
  const sweep = ellipseSweep(e);
  if (sweep >= TAU - 1e-9) return true;
  const rel = (((t - e.start) % TAU) + TAU) % TAU;
  return rel <= sweep + 1e-9;
}

/** The parameter values of the swept range, in order, `n + 1` of them. */
export function ellipseParamAt(e: Pick<EllipseGeom, "start" | "end">, f: number): number {
  return e.start + ellipseSweep(e) * f;
}

export function ellipseBounds(e: EllipseGeom): Bounds {
  const n = minorAxisOf(e);
  // d/dt x = -mx·sin t + nx·cos t = 0  →  t = atan2(nx, mx) (+π); same for y.
  const ts = [Math.atan2(n.x, e.majorAxis.x), Math.atan2(n.y, e.majorAxis.y)].flatMap((t) => [t, t + Math.PI]);
  const candidates = [e.start, e.start + ellipseSweep(e), ...ts.filter((t) => ellipseHasParam(e, t))];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of candidates) {
    const p = ellipsePointAt(e, t);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Points along the ellipse with a chord error ≤ `tol`. */
export function tessellateEllipse(e: EllipseGeom, tol: number): Point[] {
  const a = Math.hypot(e.majorAxis.x, e.majorAxis.y);
  const sweep = ellipseSweep(e);
  // A chord over parameter step Δ strays at most a·(1 − cos(Δ/2)) from the curve (a = the larger radius).
  const maxStep = a > tol ? 2 * Math.acos(1 - Math.min(1, tol / a)) : Math.PI / 2;
  const full = sweep >= TAU - 1e-9;
  const steps = Math.max(full ? 16 : 2, Math.ceil(sweep / Math.max(maxStep, 1e-3)));
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) out.push(ellipsePointAt(e, e.start + sweep * (i / steps)));
  if (full) out[out.length - 1] = out[0];
  return out;
}

/** Parameter of the point on the ellipse nearest `p`, found by sampling then Newton on the distance derivative. */
export function closestEllipseParam(e: EllipseGeom, p: Point): number {
  const sweep = ellipseSweep(e);
  const N = 64;
  let bestT = e.start;
  let bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const t = e.start + sweep * (i / N);
    const q = ellipsePointAt(e, t);
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  let t = bestT;
  for (let it = 0; it < 24; it++) {
    const q = ellipsePointAt(e, t);
    const d1 = ellipseTangentAt(e, t);
    // second derivative = −(P − center)
    const d2 = { x: -(q.x - e.center.x), y: -(q.y - e.center.y) };
    const rx = q.x - p.x;
    const ry = q.y - p.y;
    const g = rx * d1.x + ry * d1.y;
    const h = d1.x * d1.x + d1.y * d1.y + rx * d2.x + ry * d2.y;
    if (Math.abs(h) < 1e-14) break;
    const step = g / h;
    t -= step;
    if (Math.abs(step) < 1e-13) break;
  }
  // Keep the refinement only if it is still on the arc and not worse than the sample.
  if (ellipseHasParam(e, t)) {
    const q = ellipsePointAt(e, t);
    if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= bestD + 1e-12) return t;
  }
  return bestT;
}

export function distToEllipse(e: EllipseGeom, p: Point): number {
  const q = ellipsePointAt(e, closestEllipseParam(e, p));
  return Math.hypot(q.x - p.x, q.y - p.y);
}

/** Whether `p` is inside a full ellipse. */
export function pointInEllipse(e: EllipseGeom, p: Point): boolean {
  const n = minorAxisOf(e);
  const a2 = e.majorAxis.x ** 2 + e.majorAxis.y ** 2;
  const b2 = n.x ** 2 + n.y ** 2;
  const dx = p.x - e.center.x;
  const dy = p.y - e.center.y;
  const u = dx * e.majorAxis.x + dy * e.majorAxis.y; // = a² · local x
  const v = dx * n.x + dy * n.y; // = b² · local y
  return (u * u) / (a2 * a2) + (v * v) / (b2 * b2) <= 1;
}

/**
 * The ellipse under the affine map `m` = `[a, b, c, d, e, f]` (SVG order).
 * An affine image of an ellipse is an ellipse: take the images of the two
 * conjugate semi-diameters, then find the principal axes of that pair. A
 * reflecting map reverses the parameter direction, so `start`/`end` swap
 * and negate. Returns null for a degenerate (singular) map.
 */
export function transformEllipse(e: EllipseGeom, m: readonly [number, number, number, number, number, number]): EllipseGeom | null {
  const [a, b, c, d, tx, ty] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const n = minorAxisOf(e);
  const u = { x: a * e.majorAxis.x + c * e.majorAxis.y, y: b * e.majorAxis.x + d * e.majorAxis.y };
  const v = { x: a * n.x + c * n.y, y: b * n.x + d * n.y };
  const center = { x: a * e.center.x + c * e.center.y + tx, y: b * e.center.x + d * e.center.y + ty };
  // Parameter shift that makes u·cos t0 + v·sin t0 the longest semi-diameter.
  let t0 = 0.5 * Math.atan2(2 * (u.x * v.x + u.y * v.y), u.x * u.x + u.y * u.y - (v.x * v.x + v.y * v.y));
  const axisAt = (t: number): Point => ({ x: u.x * Math.cos(t) + v.x * Math.sin(t), y: u.y * Math.cos(t) + v.y * Math.sin(t) });
  if (Math.hypot(axisAt(t0).x, axisAt(t0).y) < Math.hypot(axisAt(t0 + Math.PI / 2).x, axisAt(t0 + Math.PI / 2).y)) t0 += Math.PI / 2;
  const A = axisAt(t0);
  const B = axisAt(t0 + Math.PI / 2);
  const la = Math.hypot(A.x, A.y);
  if (la < 1e-12) return null;
  const ratio = Math.min(1, Math.hypot(B.x, B.y) / la);
  // P(t) = c + A·cos(t − t0) + B·sin(t − t0); B is ±rot90(A)·ratio depending on orientation.
  const sweep = ellipseSweep(e);
  const full = sweep >= TAU - 1e-9;
  if (det > 0) {
    const start = e.start - t0;
    return { center, majorAxis: A, ratio, start, end: full ? start + TAU : start + sweep };
  }
  // Mirrored: parameter s = −(t − t0) makes B → −B equal to +rot90(A)·ratio.
  const start = full ? 0 : -(e.start + sweep - t0);
  return { center, majorAxis: A, ratio, start, end: full ? TAU : start + sweep };
}

/**
 * An ellipse from its centre, one end of an axis and the half-length of the
 * other axis (AutoCAD's ELLIPSE). Whichever is longer becomes the major axis,
 * so dragging the second distance past the first turns the ellipse over
 * instead of failing. Null when either is zero.
 */
export function ellipseFromAxes(center: Point, axisEnd: Point, otherRadius: number): EllipseGeom | null {
  const dx = axisEnd.x - center.x;
  const dy = axisEnd.y - center.y;
  const a = Math.hypot(dx, dy);
  const b = Math.abs(otherRadius);
  if (a < 1e-9 || b < 1e-9) return null;
  if (b <= a) return { center, majorAxis: { x: dx, y: dy }, ratio: b / a, start: 0, end: TAU };
  // The "other" axis is the longer one: it perpendicular to the given axis, so the major axis is that turned 90°.
  return { center, majorAxis: { x: (-dy / a) * b, y: (dx / a) * b }, ratio: a / b, start: 0, end: TAU };
}

/** The parameter `t` of the direction from the centre to `p` — what an arc's start/end pick means. */
export function ellipseParamOfPoint(e: EllipseGeom, p: Point): number {
  const n = minorAxisOf(e);
  const a2 = e.majorAxis.x ** 2 + e.majorAxis.y ** 2;
  const b2 = n.x ** 2 + n.y ** 2;
  const dx = p.x - e.center.x;
  const dy = p.y - e.center.y;
  return Math.atan2((dx * n.x + dy * n.y) / b2, (dx * e.majorAxis.x + dy * e.majorAxis.y) / a2);
}
