import type { Command } from "./commands";
import { newEntityId, type Entity, type PolylineEntity, type SplineEntity } from "./entities";
import type { Point } from "./geometry";
import { clampedUniformKnots, closestNurbsParam, insertKnot, interpolateNurbs, nurbsDomain, nurbsPointAt, tessellateNurbs } from "./nurbs";
import { refitSpline } from "./spline";
import { flattenPolylineToPoints, simplifyPolylineEntity } from "./simplify";

/**
 * Spline editing actions (C-07). All pure: each takes a spline (or polyline)
 * and returns the replacement entity, or null when the action doesn't apply.
 * Identity (id, name, layer, colour…) is carried over by spreading the input.
 */

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Drops the fit data, leaving the control points as the editable handles (what SPLINEDIT "Convert to CVs" does). */
export function splineToControlPoints(e: SplineEntity): SplineEntity | null {
  if (!e.fitPoints) return null;
  const { fitPoints: _drop, startTangent: _s, endTangent: _t, ...rest } = e;
  return rest;
}

/** Parameter of the spline's point nearest `p`. */
function paramNear(e: SplineEntity, p: Point): number {
  return closestNurbsParam(e, p);
}

/**
 * Adds a point at the spot of the curve nearest `near`. A fit spline gains a
 * fit point there (in curve order) and is re-solved; a control-point spline
 * gets a knot inserted, which adds a control point without changing the shape.
 */
export function addSplinePoint(e: SplineEntity, near: Point): SplineEntity | null {
  const u = paramNear(e, near);
  const [lo, hi] = nurbsDomain(e);
  if (!(u > lo && u < hi)) return null;
  if (e.fitPoints) {
    const on = nurbsPointAt(e, u);
    // Slot the new point between the fit points whose curve parameters bracket u.
    const params = e.fitPoints.map((p) => paramNear(e, p));
    let at = params.findIndex((t) => t > u);
    if (at < 0) at = e.fitPoints.length;
    if (at === 0) at = 1;
    const fit = [...e.fitPoints.slice(0, at), on, ...e.fitPoints.slice(at)];
    return refitSpline(e, fit);
  }
  const inserted = insertKnot(e, u);
  return { ...e, ...inserted };
}

/** Removes the fit point / control point at `index`. Control-point removal re-spaces the knots, so the shape changes slightly. */
export function removeSplinePoint(e: SplineEntity, index: number): SplineEntity | null {
  if (e.fitPoints) {
    if (e.fitPoints.length <= 2 || index < 0 || index >= e.fitPoints.length) return null;
    const fit = e.fitPoints.filter((_, i) => i !== index);
    return refitSpline(e, fit);
  }
  const n = e.controlPoints.length;
  if (index < 0 || index >= n || n - 1 < 2) return null;
  const controlPoints = e.controlPoints.filter((_, i) => i !== index);
  const degree = Math.min(e.degree, controlPoints.length - 1);
  const weights = e.weights?.filter((_, i) => i !== index);
  return { ...e, degree, controlPoints, knots: clampedUniformKnots(controlPoints.length, degree), weights };
}

/**
 * Rebuild: resamples the curve at `count` evenly spaced parameters and
 * refits a cubic through them, leaving a plain control-point spline with a
 * predictable CV count (AutoCAD SPLINEDIT → Rebuild).
 */
export function rebuildSpline(e: SplineEntity, count: number): SplineEntity | null {
  const n = Math.round(count);
  if (!(n >= 2)) return null;
  const [lo, hi] = nurbsDomain(e);
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) pts.push(nurbsPointAt(e, lo + ((hi - lo) * i) / (n - 1)));
  const fitted = interpolateNurbs(pts, Math.min(3, e.degree < 3 ? 3 : e.degree));
  if (!fitted) return null;
  const { fitPoints: _drop, startTangent: _s, endTangent: _t, ...rest } = e;
  return { ...rest, ...fitted, weights: undefined };
}

/** A fit-point spline through a polyline's vertices (curved legs are flattened first). A closed polyline gives a closed spline whose ends meet. */
export function polylineToSpline(pl: PolylineEntity): SplineEntity | null {
  const hasArc = pl.bulges?.some((b) => b !== 0) ?? false;
  const raw = hasArc ? flattenPolylineToPoints(pl, 0.05) : pl.points;
  const pts = raw.filter((p, i) => i === 0 || dist(p, raw[i - 1]) > 1e-9);
  const closed = pl.closed && pts.length >= 3;
  const run = closed ? [...pts, pts[0]] : pts;
  const fitted = interpolateNurbs(run, 3);
  if (!fitted) return null;
  const { type: _t, points: _p, bulges: _b, closed: _c, ...common } = pl;
  return { ...common, type: "spline", ...fitted, fitPoints: run, closed };
}

/** A polyline following the spline to `tolerance` (mm), with straight/arc runs fitted back to real bulge arcs. */
export function splineToPolyline(e: SplineEntity, tolerance: number): PolylineEntity | null {
  let pts = tessellateNurbs(e, Math.min(tolerance / 4, 0.05));
  if (pts.length < 2) return null;
  const closed = e.closed && pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) < 1e-6;
  if (closed) pts = pts.slice(0, -1);
  const { type: _t, degree: _d, controlPoints: _c, knots: _k, weights: _w, fitPoints: _f, closed: _cl, ...common } = e;
  const pl: PolylineEntity = { ...common, type: "polyline", points: pts, closed };
  return simplifyPolylineEntity(pl, tolerance);
}

/** Selection action: polylines → splines, replacing each (new ids, so the swap is one undo step). */
export function polylinesToSplinesCommands(entities: readonly Entity[]): Command[] {
  const out: Command[] = [];
  for (const e of entities) {
    if (e.type !== "polyline") continue;
    const s = polylineToSpline(e);
    if (!s) continue;
    out.push({ type: "delete-entities", ids: [e.id] }, { type: "add-entity", entity: { ...s, id: newEntityId() } });
  }
  return out;
}

/** Selection action: splines → polylines at `tolerance` mm. */
export function splinesToPolylinesCommands(entities: readonly Entity[], tolerance: number): Command[] {
  const out: Command[] = [];
  for (const e of entities) {
    if (e.type !== "spline") continue;
    const pl = splineToPolyline(e, tolerance);
    if (!pl) continue;
    out.push({ type: "delete-entities", ids: [e.id] }, { type: "add-entity", entity: { ...pl, id: newEntityId() } });
  }
  return out;
}
