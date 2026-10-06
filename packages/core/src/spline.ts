import type { SplineEntity } from "./entities";
import type { Grip } from "./grips";
import type { Point } from "./geometry";
import { interpolateNurbs, nurbsDomain, nurbsPointAt } from "./nurbs";
import type { Affine, KindSnap } from "./kinds/registry";

/**
 * Spline-entity behaviour on top of `nurbs.ts`: the affine map, the snap
 * points and the grips. Fit points, when the spline has them, are what the
 * user edits (control points are derived); otherwise the control points are.
 */

const mapPoint = (m: Affine, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** A NURBS curve is affine-invariant: mapping its control points maps the curve; weights and knots stay. Null for a singular map. */
export function splineTransform(e: SplineEntity, m: Affine): SplineEntity | null {
  if (Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) return null;
  return {
    ...e,
    controlPoints: e.controlPoints.map((p) => mapPoint(m, p)),
    ...(e.fitPoints ? { fitPoints: e.fitPoints.map((p) => mapPoint(m, p)) } : {}),
  };
}

export function splineSnaps(e: SplineEntity): KindSnap[] {
  const [lo, hi] = nurbsDomain(e);
  const out: KindSnap[] = [
    { point: nurbsPointAt(e, lo), kind: "endpoint" },
    { point: nurbsPointAt(e, hi), kind: "endpoint" },
  ];
  for (const p of e.fitPoints ?? []) out.push({ point: p, kind: "node" });
  return out;
}

/** The handles: fit points when present (on the curve), else control points (the control polygon's corners). */
export function splineGrips(e: SplineEntity): Grip[] {
  const pts = e.fitPoints ?? e.controlPoints;
  return pts.map((point, index) => ({ point, kind: "vertex" as const, index }));
}

export function applySplineGrip(e: SplineEntity, grip: Grip, to: Point): SplineEntity {
  if (e.fitPoints) {
    const fit = e.fitPoints.map((p, i) => (i === grip.index ? to : p));
    const fitted = interpolateNurbs(fit, e.degree);
    // A degenerate edit (two fit points on top of each other) is ignored rather than corrupting the curve.
    if (!fitted) return e;
    return { ...e, ...fitted, weights: undefined, fitPoints: fit };
  }
  return { ...e, controlPoints: e.controlPoints.map((p, i) => (i === grip.index ? to : p)) };
}
