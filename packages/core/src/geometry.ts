export interface Point {
  x: number;
  y: number;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The closest point to `p` lying on the segment a-b. */
export function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return a;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * abx, y: a.y + t * aby };
}

/** Distance from point p to the segment a-b. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  return dist(p, closestPointOnSegment(p, a, b));
}

/** Rotates `p` about `pivot` by `angle` radians (standard math convention, CCW for positive angle). */
export function rotatePoint(p: Point, pivot: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

const TAU = Math.PI * 2;

/** Reduces an angle (radians) to (-halfTurn, halfTurn], the shortest signed turn representation. */
export function shortestTurn(angle: number): number {
  let a = angle % TAU;
  if (a <= -Math.PI) a += TAU;
  if (a > Math.PI) a -= TAU;
  return a;
}

/**
 * Reduces an angle (radians) modulo a half turn, to (-PI/2, PI/2]. Used to
 * find the smallest rotation that aligns an undirected line with an axis —
 * a line pointing "backwards" is already aligned, so this avoids an
 * unnecessary 180 turn that would flip the rest of a rigidly-rotated part.
 */
export function reduceToHalfTurn(angle: number): number {
  const half = Math.PI / 2;
  let a = angle % Math.PI;
  if (a <= -half) a += Math.PI;
  if (a > half) a -= Math.PI;
  return a;
}

/**
 * Magnitude of the sweep (0, TAU] traversed from `start` to `end`, going
 * counterclockwise (increasing angle) if `ccw`, clockwise otherwise.
 * Equal start/end is treated as a full turn, matching DXF ARC convention.
 */
export function arcSweep(start: number, end: number, ccw: boolean): number {
  const raw = ccw ? end - start : start - end;
  const s = ((raw % TAU) + TAU) % TAU;
  return s === 0 ? TAU : s;
}

/** Whether `angle` lies within the arc's sweep from `start` to `end` (inclusive, with a small epsilon). */
export function angleInSweep(angle: number, start: number, end: number, ccw: boolean): boolean {
  const sweep = arcSweep(start, end, ccw);
  const raw = ccw ? angle - start : start - angle;
  const rel = ((raw % TAU) + TAU) % TAU;
  const eps = 1e-9;
  return rel <= sweep + eps;
}

/** The point on a circle of `radius` about `center` at `angle` radians. */
export function arcPointAt(center: Point, radius: number, angle: number): Point {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
}

/** Shortest distance from `p` to the arc curve (not the full circle). */
export function distToArc(
  p: Point,
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  ccw: boolean,
): number {
  const rel = Math.atan2(p.y - center.y, p.x - center.x);
  if (angleInSweep(rel, startAngle, endAngle, ccw)) {
    return Math.abs(dist(p, center) - radius);
  }
  const startPt = arcPointAt(center, radius, startAngle);
  const endPt = arcPointAt(center, radius, endAngle);
  return Math.min(dist(p, startPt), dist(p, endPt));
}

/** Points needed to bound an arc precisely: its two ends plus any axis-aligned extrema it sweeps through. */
export function arcExtentPoints(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  ccw: boolean,
): Point[] {
  const pts = [arcPointAt(center, radius, startAngle), arcPointAt(center, radius, endAngle)];
  for (const k of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    if (angleInSweep(k, startAngle, endAngle, ccw)) pts.push(arcPointAt(center, radius, k));
  }
  return pts;
}
