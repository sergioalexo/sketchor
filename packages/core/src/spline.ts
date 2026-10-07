import type { SplineEntity } from "./entities";
import type { Grip } from "./grips";
import type { Point } from "./geometry";
import { interpolateNurbs, nurbsDomain, nurbsEval, nurbsPointAt } from "./nurbs";
import type { Affine, KindSnap } from "./kinds/registry";

/**
 * Spline-entity behaviour on top of `nurbs.ts`: the affine map, the snap
 * points and the grips. Fit points, when the spline has them, are what the
 * user edits (control points are derived); otherwise the control points are.
 */

const mapPoint = (m: Affine, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

const mapVec = (m: Affine, v: Point): Point => ({ x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y });

/** A NURBS curve is affine-invariant: mapping its control points maps the curve; weights and knots stay. Null for a singular map. */
export function splineTransform(e: SplineEntity, m: Affine): SplineEntity | null {
  if (Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) return null;
  return {
    ...e,
    controlPoints: e.controlPoints.map((p) => mapPoint(m, p)),
    ...(e.fitPoints ? { fitPoints: e.fitPoints.map((p) => mapPoint(m, p)) } : {}),
    // Tangent handles are vectors: only the linear part of the map applies.
    ...(e.startTangent ? { startTangent: mapVec(m, e.startTangent) } : {}),
    ...(e.endTangent ? { endTangent: mapVec(m, e.endTangent) } : {}),
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

/** View preference, not document data: also show a fit spline's control vertices as grips (properties "Show CVs"). */
let showControlVertices = false;
export function setSplineShowCvs(on: boolean): void {
  showControlVertices = on;
}
export const splineShowCvs = (): boolean => showControlVertices;

const vecOf = (a: Point, b: Point): Point => ({ x: b.x - a.x, y: b.y - a.y });

/** A fit spline refitted through `fit` honouring its end tangents (a closed spline ignores them). Null when degenerate. */
export function refitSpline(e: SplineEntity, fit: Point[]): SplineEntity | null {
  const fitted = interpolateNurbs(fit, e.degree, e.closed ? undefined : { start: e.startTangent, end: e.endTangent });
  return fitted ? { ...e, ...fitted, weights: undefined, fitPoints: fit } : null;
}

/** The tangent handle at an end: the stored vector, else the curve's own direction there (a third of its end derivative). */
export function splineEndHandle(e: SplineEntity, which: "start" | "end"): Point {
  const stored = which === "start" ? e.startTangent : e.endTangent;
  if (stored) return stored;
  const [lo, hi] = nurbsDomain(e);
  const d = nurbsEval(e, which === "start" ? lo : hi).tangent;
  // The stored scale is per unit of a 0..1 parameter; the entity's knots may span another range.
  const span = hi - lo || 1;
  return { x: (d.x * span) / 3, y: (d.y * span) / 3 };
}

/** The handles: fit points when present (on the curve) plus end-tangent handles, else control points (the control polygon's corners). */
export function splineGrips(e: SplineEntity): Grip[] {
  if (!e.fitPoints) return e.controlPoints.map((point, index) => ({ point, kind: "vertex" as const, index }));
  const out: Grip[] = e.fitPoints.map((point, index) => ({ point, kind: "vertex" as const, index }));
  if (!e.closed && e.fitPoints.length >= 2) {
    const s = e.fitPoints[0];
    const t = e.fitPoints[e.fitPoints.length - 1];
    const hs = splineEndHandle(e, "start");
    const he = splineEndHandle(e, "end");
    out.push({ point: { x: s.x + hs.x, y: s.y + hs.y }, kind: "tangent", index: 0 });
    // The end handle points back along the curve so the two handles read the same way.
    out.push({ point: { x: t.x - he.x, y: t.y - he.y }, kind: "tangent", index: 1 });
  }
  if (showControlVertices) e.controlPoints.forEach((point, index) => out.push({ point, kind: "cv", index }));
  return out;
}

export function applySplineGrip(e: SplineEntity, grip: Grip, to: Point): SplineEntity {
  if (grip.kind === "cv") {
    // Pulling a control vertex of a fit spline edits it as a control-point spline: the fit data no longer describes the curve.
    const { fitPoints: _f, startTangent: _s, endTangent: _t, ...rest } = e;
    return { ...rest, controlPoints: e.controlPoints.map((p, i) => (i === grip.index ? to : p)) };
  }
  if (grip.kind === "tangent" && e.fitPoints) {
    const fit = e.fitPoints;
    const next = grip.index === 0 ? { ...e, startTangent: vecOf(fit[0], to) } : { ...e, endTangent: vecOf(to, fit[fit.length - 1]) };
    // A zero-length handle would be ignored by the solve; keep the previous curve instead of silently dropping it.
    const h = grip.index === 0 ? next.startTangent! : next.endTangent!;
    if (Math.hypot(h.x, h.y) < 1e-9) return e;
    return refitSpline(next, fit) ?? e;
  }
  if (e.fitPoints) {
    const fit = e.fitPoints.map((p, i) => (i === grip.index ? to : p));
    // A degenerate edit (two fit points on top of each other) is ignored rather than corrupting the curve.
    return refitSpline(e, fit) ?? e;
  }
  return { ...e, controlPoints: e.controlPoints.map((p, i) => (i === grip.index ? to : p)) };
}
