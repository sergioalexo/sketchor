import type { Constraint, ConstraintId } from "../constraints";
import type { EllipseEntity, Entity, SplineEntity } from "../entities";
import { closestEllipseParam, ellipsePointAt, ellipseSweep, ellipseTangentAt } from "../ellipse";
import type { Point } from "../geometry";
import { closestNurbsParam, isValidNurbs, nurbsDomain, nurbsEval, type NurbsData } from "../nurbs";
import { pointOf, type SketchModel } from "./model";
import { add, cosNum, div, konst, mul, scale, sinNum, sub, variable, type Num, type Vec } from "./num";

/**
 * Curves the solver cannot write as one closed-form equation (a spline, and
 * an ellipse when it must be *tangent* to something) are handled with a
 * **foot parameter** (C-09): one extra unknown `t` per constraint, the
 * curve parameter of the point of contact. The constraint then reads like
 * it does for a line — "the curve's point P(t) is on the line, and its
 * tangent P'(t) is parallel to the line" — and the solver finds `t` along
 * with the geometry. `t` lives past the entity parameters in
 * `SketchModel.values` (`model.aux`), is started at the nearest point of
 * contact, is never written back to the document, and adds exactly one
 * column and (with the rows that use it) the right number of equations, so
 * the degrees-of-freedom tally stays honest.
 *
 * `P(t)` and `P'(t)` are built from {@link Num}s, so the Jacobian with
 * respect to the control points, ellipse axes and `t` is automatic. A
 * spline is evaluated with the Cox–de Boor triangle in `Num` arithmetic
 * (denominators are knot differences — constants), and its derivative with
 * the hodograph curve (degree p−1), with the quotient rule for weights.
 */

/** Whether a foot-parameter curve can be built for this entity. */
export function isFootCurve(e: Entity | undefined): e is EllipseEntity | SplineEntity {
  if (!e) return false;
  if (e.type === "ellipse") return true;
  return e.type === "spline" && isValidNurbs(e);
}

/** The constraints that need a foot parameter on `curveId` (and the curve's entity id) — one aux per constraint. */
export function footCurveOf(model: SketchModel, c: Constraint): string | null {
  const isFoot = (id: string) => isFootCurve(model.entities.get(id));
  if (c.type === "point-on-curve") {
    const e = model.entities.get(c.entityId);
    return e?.type === "spline" && isFootCurve(e) ? c.entityId : null;
  }
  if (c.type === "tangent") {
    const a = model.entities.get(c.a);
    const b = model.entities.get(c.b);
    const lineish = (e: Entity | undefined) => e && (e.type === "line" || e.type === "circle" || e.type === "arc");
    if (isFoot(c.a) && lineish(b)) return c.a;
    if (isFoot(c.b) && lineish(a)) return c.b;
  }
  return null;
}

/** Appends one foot parameter per constraint that needs one, started at the nearest candidate contact. */
export function addFootParams(model: SketchModel, constraints: readonly Constraint[]): void {
  const aux = new Map<ConstraintId, number>();
  for (const c of constraints) {
    const curveId = footCurveOf(model, c);
    if (!curveId) continue;
    const curve = model.entities.get(curveId) as EllipseEntity | SplineEntity;
    const t0 = startingFoot(model, c, curve);
    aux.set(c.id, model.values.length);
    model.values.push(t0);
  }
  if (aux.size > 0) model.aux = aux;
}

/** The foot parameter variable for `c`, or null when it has none. */
export function footOf(model: SketchModel, c: Constraint): Num | null {
  const i = model.aux?.get(c.id);
  return i === undefined ? null : variable(i, model.values[i]);
}

function numPoint(model: SketchModel, ref: Parameters<typeof pointOf>[1]): Point | null {
  const p = pointOf(model, ref);
  return p ? { x: p.x.v, y: p.y.v } : null;
}

const SAMPLES = 96;

function startingFoot(model: SketchModel, c: Constraint, curve: EllipseEntity | SplineEntity): number {
  if (c.type === "point-on-curve") {
    const p = numPoint(model, c.point);
    if (!p) return paramRange(curve)[0];
    return curve.type === "ellipse" ? closestEllipseParam(curve, p) : closestNurbsParam(curve, p);
  }
  // Tangent: the sample whose point is nearest the other shape and whose direction best matches it.
  const otherId = c.type === "tangent" ? (c.a === curve.id ? c.b : c.a) : "";
  const other = model.entities.get(otherId);
  const [lo, hi] = paramRange(curve);
  let best = lo;
  let bestCost = Infinity;
  const pts: { t: number; p: Point; d: Point }[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = lo + ((hi - lo) * i) / SAMPLES;
    pts.push({ t, ...sampleCurve(curve, t) });
  }
  const R = Math.max(1e-9, ...pts.map((s) => Math.hypot(s.p.x - pts[0].p.x, s.p.y - pts[0].p.y)));
  for (const s of pts) {
    const dl = Math.hypot(s.d.x, s.d.y) || 1;
    let off = 0;
    let align = 0;
    if (other?.type === "line") {
      const ex = other.b.x - other.a.x;
      const ey = other.b.y - other.a.y;
      const el = Math.hypot(ex, ey) || 1;
      off = ((s.p.x - other.a.x) * ey - (s.p.y - other.a.y) * ex) / el;
      align = (s.d.x * ey - s.d.y * ex) / (dl * el);
    } else if (other && (other.type === "circle" || other.type === "arc")) {
      const rx = s.p.x - other.center.x;
      const ry = s.p.y - other.center.y;
      const rl = Math.hypot(rx, ry) || 1;
      off = rl - other.radius;
      align = (s.d.x * rx + s.d.y * ry) / (dl * rl);
    }
    const cost = off * off + (align * R) ** 2;
    if (cost < bestCost) {
      bestCost = cost;
      best = s.t;
    }
  }
  return best;
}

function paramRange(curve: EllipseEntity | SplineEntity): [number, number] {
  if (curve.type === "ellipse") return [curve.start, curve.start + ellipseSweep(curve)];
  return nurbsDomain(curve as NurbsData);
}

function sampleCurve(curve: EllipseEntity | SplineEntity, t: number): { p: Point; d: Point } {
  if (curve.type === "ellipse") return { p: ellipsePointAt(curve, t), d: ellipseTangentAt(curve, t) };
  const ev = nurbsEval(curve as NurbsData, t);
  return { p: ev.point, d: ev.tangent };
}

/* ------------------------------ Num evaluation ------------------------------ */

/**
 * The curve's point and parameter-derivative at the (variable) parameter
 * `t`, as solver values. For an ellipse, `t` is the angle and the
 * parameters are centre, major-axis vector and ratio; for a spline, the
 * control-point parameters (knots/weights are constants).
 */
export function curveEval(model: SketchModel, id: string, t: Num): { p: Vec; d: Vec } | null {
  const e = model.entities.get(id);
  const mp = model.byEntity.get(id);
  if (!e || !mp) return null;
  const par = (k: number): Num => {
    const i = mp.start + k;
    return model.frozen.has(i) ? konst(model.values[i]) : variable(i, model.values[i]);
  };
  if (e.type === "ellipse") {
    const cx = par(0), cy = par(1), mx = par(2), my = par(3), r = par(4);
    const nx = scale(mul(my, r), -1);
    const ny = mul(mx, r);
    const c = cosNum(t);
    const s = sinNum(t);
    return {
      p: { x: add(cx, add(mul(mx, c), mul(nx, s))), y: add(cy, add(mul(my, c), mul(ny, s))) },
      d: { x: add(scale(mul(mx, s), -1), mul(nx, c)), y: add(scale(mul(my, s), -1), mul(ny, c)) },
    };
  }
  if (e.type === "spline" && isValidNurbs(e)) {
    const n = e.controlPoints.length;
    const w = (i: number): number => e.weights?.[i] ?? 1;
    const rational = !!e.weights;
    // Homogeneous control points: (w·x, w·y, w).
    const ctrl: Num[][] = [];
    for (let i = 0; i < n; i++) ctrl.push(rational ? [scale(par(i * 2), w(i)), scale(par(i * 2 + 1), w(i)), konst(w(i))] : [par(i * 2), par(i * 2 + 1)]);
    const [lo, hi] = nurbsDomain(e);
    const tc = t.v < lo ? konst(lo) : t.v > hi ? konst(hi) : t;
    const a = bsplineEval(e.knots, e.degree, ctrl, tc);
    const da = bsplineDerivative(e.knots, e.degree, ctrl, tc);
    if (!rational) return { p: { x: a[0], y: a[1] }, d: { x: da[0], y: da[1] } };
    // P = A/W, P' = (A' − W'·P)/W.
    const W = a[2];
    const px = div(a[0], W);
    const py = div(a[1], W);
    return {
      p: { x: px, y: py },
      d: { x: div(sub(da[0], mul(da[2], px)), W), y: div(sub(da[1], mul(da[2], py)), W) },
    };
  }
  return null;
}

function spanOf(knots: readonly number[], degree: number, nCtrl: number, u: number): number {
  const n = nCtrl - 1;
  if (u >= knots[n + 1]) {
    // The last non-empty span.
    let s = n;
    while (s > degree && knots[s] === knots[s + 1]) s--;
    return s;
  }
  let s = degree;
  while (s < n && u >= knots[s + 1]) s++;
  return s;
}

/** Cox–de Boor on Num: the degree+1 non-zero basis functions for `span` at `t`. */
function basis(knots: readonly number[], span: number, degree: number, t: Num): Num[] {
  const N: Num[] = new Array(degree + 1).fill(null).map(() => konst(0));
  const left: Num[] = new Array(degree + 1).fill(null).map(() => konst(0));
  const right: Num[] = new Array(degree + 1).fill(null).map(() => konst(0));
  N[0] = konst(1);
  for (let j = 1; j <= degree; j++) {
    left[j] = sub(t, konst(knots[span + 1 - j]));
    right[j] = sub(konst(knots[span + j]), t);
    let saved: Num = konst(0);
    for (let r = 0; r < j; r++) {
      const denom = knots[span + r + 1] - knots[span + 1 - j + r];
      const temp = denom === 0 ? konst(0) : scale(N[r], 1 / denom);
      N[r] = add(saved, mul(right[r + 1], temp));
      saved = mul(left[j - r], temp);
    }
    N[j] = saved;
  }
  return N;
}

function bsplineEval(knots: readonly number[], degree: number, ctrl: Num[][], t: Num): Num[] {
  const span = spanOf(knots, degree, ctrl.length, t.v);
  const N = basis(knots, span, degree, t);
  const dim = ctrl[0].length;
  const out: Num[] = new Array(dim).fill(null).map(() => konst(0));
  for (let k = 0; k <= degree; k++) {
    const cp = ctrl[span - degree + k];
    for (let d = 0; d < dim; d++) out[d] = add(out[d], mul(N[k], cp[d]));
  }
  return out;
}

/** d/dt through the hodograph: a degree p−1 B-spline over the scaled control-point differences. */
function bsplineDerivative(knots: readonly number[], degree: number, ctrl: Num[][], t: Num): Num[] {
  const dim = ctrl[0].length;
  const q: Num[][] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const denom = knots[i + degree + 1] - knots[i + 1];
    const f = denom === 0 ? 0 : degree / denom;
    q.push(ctrl[i + 1].map((c, d) => scale(sub(c, ctrl[i][d]), f)));
  }
  const dk = knots.slice(1, knots.length - 1);
  if (dim === 0 || q.length === 0) return new Array(dim).fill(null).map(() => konst(0));
  return bsplineEval(dk, degree - 1, q, t);
}
