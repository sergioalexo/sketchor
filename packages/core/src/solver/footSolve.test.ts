import "../kinds/builtin";
import { describe, expect, it } from "vitest";
import type { Constraint } from "../constraints";
import { buildConstraints } from "../constraintBuilder";
import type { CircleEntity, EllipseEntity, Entity, LineEntity, PointEntity, SplineEntity } from "../entities";
import { ellipsePointAt } from "../ellipse";
import { distToNurbs, nurbsDomain, nurbsPointAt } from "../nurbs";
import { clampedUniformKnots } from "../nurbs";
import { gripPointRef, gripsOf } from "../grips";
import { solveSketch } from "./solve";

/**
 * C-09: point-on-spline and tangency of an ellipse/spline to a line or circle
 * use a per-constraint foot parameter. What a user sees: the point lands ON
 * the spline, the line touches the curve without crossing it, a circle kisses
 * it, and the DoF tally drops by exactly one per constraint. The properties
 * are geometric (distance, sign of the offset along the curve), not literals.
 */

const spline = (over: Partial<SplineEntity> = {}): SplineEntity => ({
  id: "s",
  type: "spline",
  degree: 3,
  controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: -10 }, { x: 40, y: 0 }],
  knots: clampedUniformKnots(4, 3),
  closed: false,
  ...over,
});
const ellipse = (): EllipseEntity => ({ id: "e", type: "ellipse", center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5, start: 0, end: Math.PI * 2 });
const at = (entities: Entity[], updates: Entity[], id: string) => [...entities, ...updates].reverse().find((e) => e.id === id)!;
const fix = (id: string): Constraint => ({ id: `fix-${id}`, type: "fix", entityId: id });

/** Signed distance from `p` to the infinite line `a`-`b`. */
const side = (a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }) =>
  ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);

describe("point on a spline", () => {
  it("moves a free point onto a fixed spline", () => {
    const entities: Entity[] = [spline(), { id: "p", type: "point", p: { x: 18, y: 14 } }];
    const r = solveSketch(entities, [fix("s"), { id: "k", type: "point-on-curve", point: { entityId: "p", point: "a" }, entityId: "s" }]);
    expect(r.converged).toBe(true);
    const p = at(entities, r.updates, "p") as PointEntity;
    expect(distToNurbs(spline(), p.p)).toBeLessThan(1e-6);
    expect(r.dof).toBe(1); // sliding along the curve
  });

  it("bends a free spline through a fixed point (control points move)", () => {
    const entities: Entity[] = [spline(), { id: "p", type: "point", p: { x: 20, y: 8 } }];
    const r = solveSketch(entities, [fix("p"), { id: "k", type: "point-on-curve", point: { entityId: "p", point: "a" }, entityId: "s" }]);
    expect(r.converged).toBe(true);
    const s = at(entities, r.updates, "s") as SplineEntity;
    expect(distToNurbs(s, { x: 20, y: 8 })).toBeLessThan(1e-6);
  });

  it("works on a rational spline too", () => {
    const s0 = spline({ weights: [1, 2, 0.5, 1] });
    const entities: Entity[] = [s0, { id: "p", type: "point", p: { x: 15, y: 12 } }];
    const r = solveSketch(entities, [fix("s"), { id: "k", type: "point-on-curve", point: { entityId: "p", point: "a" }, entityId: "s" }]);
    const p = at(entities, r.updates, "p") as PointEntity;
    expect(distToNurbs(s0, p.p)).toBeLessThan(1e-6);
  });
});

describe("tangency of curves", () => {
  it("makes a line touch a fixed spline without crossing it", () => {
    const entities: Entity[] = [spline(), { id: "l", type: "line", a: { x: -5, y: 12 }, b: { x: 45, y: 14 } }];
    const r = solveSketch(entities, [fix("s"), { id: "k", type: "tangent", a: "s", b: "l" }]);
    expect(r.converged).toBe(true);
    const l = at(entities, r.updates, "l") as LineEntity;
    const [lo, hi] = nurbsDomain(spline());
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i <= 400; i++) {
      const d = side(l.a, l.b, nurbsPointAt(spline(), lo + ((hi - lo) * i) / 400));
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    // Touches (one extreme is ~0) and does not cross (both extremes on one side).
    expect(Math.min(Math.abs(min), Math.abs(max))).toBeLessThan(1e-3);
    expect(min * max).toBeGreaterThanOrEqual(-1e-6);
  });

  it("makes a line tangent to an ellipse (distance matches the support function)", () => {
    const entities: Entity[] = [ellipse(), { id: "l", type: "line", a: { x: -20, y: 7 }, b: { x: 20, y: 8 } }];
    const r = solveSketch(entities, [fix("e"), { id: "k", type: "tangent", a: "l", b: "e" }]);
    expect(r.converged).toBe(true);
    const l = at(entities, r.updates, "l") as LineEntity;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 720; i++) {
      const d = side(l.a, l.b, ellipsePointAt(ellipse(), (i / 720) * Math.PI * 2));
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    expect(Math.min(Math.abs(min), Math.abs(max))).toBeLessThan(2e-3);
    expect(min * max).toBeGreaterThanOrEqual(-1e-6);
  });

  it("makes a circle tangent to an ellipse by moving the circle", () => {
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 14, y: 3 }, radius: 3 };
    const entities: Entity[] = [ellipse(), c];
    const r = solveSketch(entities, [fix("e"), { id: "k", type: "tangent", a: "e", b: "c" }]);
    expect(r.converged).toBe(true);
    const moved = at(entities, r.updates, "c") as CircleEntity;
    // Gap between the circle and the ellipse is zero: nearest sampled ellipse point is one radius from the centre.
    let best = Infinity;
    for (let i = 0; i < 3600; i++) {
      const p = ellipsePointAt(ellipse(), (i / 3600) * Math.PI * 2);
      best = Math.min(best, Math.abs(Math.hypot(p.x - moved.center.x, p.y - moved.center.y) - moved.radius));
    }
    expect(best).toBeLessThan(2e-3);
  });

  it("a tangent constraint removes exactly one degree of freedom", () => {
    const entities: Entity[] = [spline(), { id: "l", type: "line", a: { x: -5, y: 12 }, b: { x: 45, y: 14 } }];
    const free = solveSketch(entities, [fix("s")]);
    const tangent = solveSketch(entities, [fix("s"), { id: "k", type: "tangent", a: "s", b: "l" }]);
    expect(free.dof - tangent.dof).toBe(1);
  });
});

describe("equal major axes and builder rules", () => {
  const ctx = { newId: (() => { let n = 0; return () => `k${++n}`; })() };
  it("equal on two ellipses matches their semi-major lengths", () => {
    const e2: EllipseEntity = { ...ellipse(), id: "e2", center: { x: 40, y: 0 }, majorAxis: { x: 0, y: 6 } };
    const built = buildConstraints("equal", [ellipse(), e2], ctx);
    if (!("constraints" in built)) throw new Error(built.error);
    const r = solveSketch([ellipse(), e2], [fix("e"), ...built.constraints]);
    const out = at([ellipse(), e2], r.updates, "e2") as EllipseEntity;
    expect(Math.hypot(out.majorAxis.x, out.majorAxis.y)).toBeCloseTo(10, 6);
  });
  it("parallel takes an ellipse axis and a line", () => {
    const line: Entity = { id: "l", type: "line", a: { x: 0, y: 10 }, b: { x: 10, y: 14 } };
    expect("constraints" in buildConstraints("parallel", [ellipse(), line], ctx)).toBe(true);
  });
  it("tangent accepts ellipse/spline with a line or circle; point-on-curve accepts a spline", () => {
    const line: Entity = { id: "l", type: "line", a: { x: 0, y: 10 }, b: { x: 10, y: 14 } };
    expect("constraints" in buildConstraints("tangent", [ellipse(), line], ctx)).toBe(true);
    expect("constraints" in buildConstraints("tangent", [spline(), { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 1 }], ctx)).toBe(true);
    expect("error" in buildConstraints("tangent", [ellipse(), spline({ id: "s2" })], ctx)).toBe(true);
    const pt: Entity = { id: "p", type: "point", p: { x: 1, y: 1 } };
    expect("constraints" in buildConstraints("point-on-curve", [spline(), pt], ctx)).toBe(true);
  });
});

describe("grip drag-solve", () => {
  it("an ellipse's centre and major-end grips, and a control-point spline's vertex grips, name solver points", () => {
    const e = ellipse();
    const grips = gripsOf(e);
    expect(gripPointRef(e, grips[0])).toEqual({ entityId: "e", point: "center" });
    expect(gripPointRef(e, grips[1])).toEqual({ entityId: "e", point: "a" });
    expect(gripPointRef(e, grips[2])).toBeNull(); // minor end sets the ratio: a plain edit
    const s = spline();
    expect(gripPointRef(s, gripsOf(s)[2])).toEqual({ entityId: "s", point: "vertex", index: 2 });
    const fitted = spline({ fitPoints: [{ x: 0, y: 0 }, { x: 40, y: 0 }] });
    expect(gripPointRef(fitted, gripsOf(fitted)[0])).toBeNull();
  });

  it("dragging a spline control vertex drags the point constrained to the curve with it", () => {
    const entities: Entity[] = [spline(), { id: "p", type: "point", p: { x: 20, y: 6 } }];
    const cs: Constraint[] = [{ id: "k0", type: "point-on-curve", point: { entityId: "p", point: "a" }, entityId: "s" }];
    const start = solveSketch(entities, cs);
    const base = [...entities.filter((x) => x.id !== "s" && x.id !== "p"), ...entities.map((x) => at(entities, start.updates, x.id))];
    const dragged = solveSketch(base, cs, { drag: { ref: { entityId: "s", point: "vertex", index: 1 }, to: { x: 10, y: 35 } } });
    expect(dragged.converged).toBe(true);
    const s = at(base, dragged.updates, "s") as SplineEntity;
    const p = at(base, dragged.updates, "p") as PointEntity;
    expect(s.controlPoints[1].y).toBeGreaterThan(20); // followed the cursor
    expect(distToNurbs(s, p.p)).toBeLessThan(1e-6); // and the point stayed on the curve
  });
});
