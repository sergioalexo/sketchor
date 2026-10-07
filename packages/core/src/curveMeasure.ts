import type { Entity, PolylineEntity } from "./entities";
import { arcSweep, dist, type Point } from "./geometry";
import { exactPathOf, curveLength, type XCurve, type XPath } from "./intersect";
import { ellipseSweep, minorAxisOf, tessellateEllipse } from "./ellipse";
import { nurbsDomain, nurbsEval, tessellateNurbs } from "./nurbs";
import { simplifyPolylineEntity } from "./simplify";

/**
 * Measuring and flattening exact curves (C-08): arc length, enclosed area
 * (Green's theorem on the true curve — closed form for a segment, arc and
 * ellipse, Gauss–Legendre per knot span for a NURBS, so exact for a
 * polynomial spline) and conversion of ellipses/splines to arc-fitted
 * polylines for consumers that only understand lines and arcs (nesting,
 * G-code).
 */

// 8-point Gauss–Legendre nodes/weights on [-1, 1] (positive half).
const GL_X = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

function gauss(f: (u: number) => number, a: number, b: number): number {
  const h = (b - a) / 2;
  const m = (a + b) / 2;
  let sum = 0;
  for (let i = 0; i < GL_X.length; i++) sum += GL_W[i] * (f(m - h * GL_X[i]) + f(m + h * GL_X[i]));
  return sum * h;
}

const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;

/** ½∫(x dy − y dx) along one curve (signed: counterclockwise loops are positive). */
function greenTerm(c: XCurve): number {
  switch (c.kind) {
    case "segment":
      return cross(c.a, c.b) / 2;
    case "arc": {
      const mag = c.full ? Math.PI * 2 : arcSweep(c.startAngle, c.endAngle, c.ccw);
      const dth = c.ccw ? mag : -mag;
      const a0 = c.startAngle;
      const p0 = { x: c.center.x + c.radius * Math.cos(a0), y: c.center.y + c.radius * Math.sin(a0) };
      const p1 = { x: c.center.x + c.radius * Math.cos(a0 + dth), y: c.center.y + c.radius * Math.sin(a0 + dth) };
      return 0.5 * (cross(c.center, { x: p1.x - p0.x, y: p1.y - p0.y }) + c.radius * c.radius * dth);
    }
    case "ellipse": {
      const e = c.e;
      const dt = ellipseSweep(e);
      const u = e.majorAxis;
      const v = minorAxisOf(e);
      const at = (t: number): Point => ({
        x: e.center.x + u.x * Math.cos(t) + v.x * Math.sin(t),
        y: e.center.y + u.y * Math.cos(t) + v.y * Math.sin(t),
      });
      const p0 = at(e.start);
      const p1 = at(e.start + dt);
      return 0.5 * (cross(e.center, { x: p1.x - p0.x, y: p1.y - p0.y }) + cross(u, v) * dt);
    }
    case "nurbs": {
      const [lo, hi] = nurbsDomain(c.s);
      const spans = [...new Set(c.s.knots.filter((k) => k >= lo && k <= hi))].sort((a, b) => a - b);
      let total = 0;
      for (let i = 0; i + 1 < spans.length; i++) {
        const parts = 4;
        for (let j = 0; j < parts; j++) {
          const a = spans[i] + ((spans[i + 1] - spans[i]) * j) / parts;
          const b = spans[i] + ((spans[i + 1] - spans[i]) * (j + 1)) / parts;
          total += gauss((u) => {
            const ev = nurbsEval(c.s, u);
            return cross(ev.point, ev.tangent);
          }, a, b);
        }
      }
      return total / 2;
    }
  }
}

/** Signed area enclosed by a closed path (counterclockwise positive); 0 for an open path. */
export function pathSignedArea(path: XPath): number {
  if (!path.closed) return 0;
  let sum = 0;
  for (const c of path.curves) sum += greenTerm(c);
  return sum;
}

/** Length of an entity's stroke (line, arc, circle, polyline, ellipse, spline), or null for entities with none. */
export function entityLength(entity: Entity): number | null {
  const path = exactPathOf(entity);
  if (!path || path.curves.length === 0) return null;
  let sum = 0;
  for (const c of path.curves) sum += curveLength(c);
  return sum;
}

/** Area enclosed by a single closed entity (circle, closed polyline/ellipse/spline), or null if it isn't one. */
export function entityArea(entity: Entity): number | null {
  if (entity.type !== "circle" && entity.type !== "polyline" && entity.type !== "ellipse" && entity.type !== "spline") return null;
  const path = exactPathOf(entity);
  if (!path || !path.closed) return null;
  return Math.abs(pathSignedArea(path));
}

/** An ellipse's or spline's outline (or open run) as plain points at chord tolerance `tol`, no repeated closing point. */
export function curveEntityPoints(entity: Entity, tol: number): { points: Point[]; closed: boolean } | null {
  const path = exactPathOf(entity);
  if (!path || path.curves.length !== 1) return null;
  const c = path.curves[0];
  let pts: Point[];
  if (c.kind === "ellipse") pts = tessellateEllipse(c.e, tol);
  else if (c.kind === "nurbs") pts = tessellateNurbs(c.s, tol);
  else return null;
  if (pts.length < 2) return null;
  const closed = path.closed;
  if (closed && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts = pts.slice(0, -1);
  return { points: pts, closed };
}

/**
 * Ellipses and splines turned into polylines that follow them to `tol` mm,
 * with straight/arc runs fitted back to real bulge arcs (ids and
 * appearance kept), everything else passed through. For consumers that only
 * understand lines and arcs: nesting, G-code.
 */
export function curvesToPolylines(entities: readonly Entity[], tol: number): Entity[] {
  return entities.map((e) => {
    if (e.type !== "ellipse" && e.type !== "spline") return e;
    const flat = curveEntityPoints(e, Math.min(tol / 4, 0.05));
    if (!flat) return e;
    const rest = { ...e } as Record<string, unknown>;
    for (const k of ["type", "center", "majorAxis", "ratio", "start", "end", "degree", "controlPoints", "knots", "weights", "fitPoints", "closed"]) delete rest[k];
    const pl = { ...rest, type: "polyline", points: flat.points, closed: flat.closed } as unknown as PolylineEntity;
    return simplifyPolylineEntity(pl, tol);
  });
}
