import { describe, expect, it } from "vitest";
import type { Constraint } from "../constraints";
import { buildConstraints, attachPoints } from "../constraintBuilder";
import { clampedUniformKnots } from "../nurbs";
import type { EllipseEntity, Entity, SplineEntity } from "../entities";
import { solveSketch } from "./solve";

/**
 * C-09: an ellipse and a spline are solver geometry. What matters is that a
 * constraint moves them the way the user meant (a point lands ON the ellipse,
 * the major axis turns horizontal) and that the DoF tally counts the real
 * numbers: an ellipse has 5 (centre, major-axis vector, ratio), a spline two
 * per control vertex.
 */

const ellipse = (over: Partial<EllipseEntity> = {}): EllipseEntity => ({
  id: "e",
  type: "ellipse",
  center: { x: 0, y: 0 },
  majorAxis: { x: 10, y: 0 },
  ratio: 0.5,
  start: 0,
  end: Math.PI * 2,
  ...over,
});
const spline = (): SplineEntity => ({
  id: "s",
  type: "spline",
  degree: 3,
  controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: -10 }, { x: 40, y: 0 }],
  knots: clampedUniformKnots(4, 3),
  fitPoints: [{ x: 0, y: 0 }, { x: 40, y: 0 }],
  closed: false,
});
const at = (entities: Entity[], updates: Entity[], id: string) => [...entities, ...updates].reverse().find((e) => e.id === id)!;

describe("constraints on an ellipse", () => {
  it("puts a point on the ellipse, moving the point (the ellipse is fixed)", () => {
    const entities: Entity[] = [ellipse(), { id: "p", type: "point", p: { x: 12, y: 4 } }];
    const cs: Constraint[] = [{ id: "k0", type: "fix", entityId: "e" }, { id: "k1", type: "point-on-curve", point: { entityId: "p", point: "a" }, entityId: "e" }];
    const r = solveSketch(entities, cs);
    expect(r.converged).toBe(true);
    const p = at(entities, r.updates, "p");
    if (p.type !== "point") throw new Error();
    expect((p.p.x / 10) ** 2 + (p.p.y / 5) ** 2).toBeCloseTo(1, 6);
  });

  it("makes a tilted major axis horizontal", () => {
    const entities: Entity[] = [ellipse({ majorAxis: { x: 10, y: 3 } })];
    const r = solveSketch(entities, [{ id: "k", type: "horizontal", entityId: "e" }]);
    const e = at(entities, r.updates, "e") as EllipseEntity;
    expect(e.majorAxis.y).toBeCloseTo(0, 9);
  });

  it("joins an ellipse's centre to a circle's (concentric) and counts 5 DoF for a lone ellipse", () => {
    const entities: Entity[] = [ellipse({ center: { x: 3, y: 4 } }), { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 2 }];
    const r = solveSketch(entities, [{ id: "k", type: "concentric", a: "e", b: "c" }]);
    const e = at(entities, r.updates, "e") as EllipseEntity;
    const c = at(entities, r.updates, "c") as Extract<Entity, { type: "circle" }>;
    expect(e.center.x).toBeCloseTo(c.center.x, 6);
    expect(e.center.y).toBeCloseTo(c.center.y, 6);
    expect(solveSketch([ellipse()], []).dof).toBe(5);
  });

  it("a fixed ellipse has no degrees of freedom; a point glued to its start follows an edit", () => {
    const entities: Entity[] = [ellipse({ start: 0, end: Math.PI }), { id: "p", type: "point", p: { x: 9, y: 1 } }];
    const cs: Constraint[] = [{ id: "k0", type: "fix", entityId: "e" }, { id: "k1", type: "coincident", a: { entityId: "p", point: "a" }, b: { entityId: "e", point: "a" } }];
    const r = solveSketch(entities, cs);
    const p = at(entities, r.updates, "p");
    if (p.type !== "point") throw new Error();
    expect(p.p.x).toBeCloseTo(10, 6);
    expect(p.p.y).toBeCloseTo(0, 6);
    expect(r.dof).toBe(0);
  });
});

describe("constraints on a spline", () => {
  it("pins a spline's end to a point; moving it drops stale fit points", () => {
    const entities: Entity[] = [spline(), { id: "p", type: "point", p: { x: 45, y: 5 } }, ];
    const cs: Constraint[] = [{ id: "k0", type: "fix", entityId: "p" }, { id: "k1", type: "coincident", a: { entityId: "s", point: "b" }, b: { entityId: "p", point: "a" } }];
    const r = solveSketch(entities, cs);
    const s = at(entities, r.updates, "s") as SplineEntity;
    expect(s.controlPoints[3].x).toBeCloseTo(45, 6);
    expect(s.controlPoints[3].y).toBeCloseTo(5, 6);
    expect(s.fitPoints).toBeUndefined();
    expect(s.knots).toEqual(spline().knots);
  });
  it("counts two DoF per control vertex", () => {
    expect(solveSketch([spline()], []).dof).toBe(8);
  });
});

describe("selection rules", () => {
  const ctx = { newId: (() => { let n = 0; return () => `k${++n}`; })() };
  it("horizontal and point-on-curve accept an ellipse; attach points exist for ellipse and spline", () => {
    expect("constraints" in buildConstraints("horizontal", [ellipse()], ctx)).toBe(true);
    const pt: Entity = { id: "p", type: "point", p: { x: 1, y: 1 } };
    const r = buildConstraints("point-on-curve", [ellipse(), pt], ctx);
    expect("constraints" in r && r.constraints[0].type).toBe("point-on-curve");
    expect(attachPoints(ellipse()).map((a) => a.ref.point)).toEqual(["center", "a"]);
    expect(attachPoints(spline()).map((a) => a.ref.point)).toEqual(["a", "b"]);
  });
});
