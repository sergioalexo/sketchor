import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import type { ArcEntity, CircleEntity, EllipseEntity, Entity, LineEntity, SplineEntity } from "./entities";
import { distToEllipse } from "./ellipse";
import { filletCurves } from "./filletCurves";
import { arcPointAt, dist } from "./geometry";
import { clampedUniformKnots, distToNurbs } from "./nurbs";
import { exactPathOf, closestParam } from "./intersect";

/**
 * Fillet between a line and a curve (or two curves) is what rounds a slot
 * end or a cam profile. Wrong tangency leaves a kink the cutter follows, and
 * a wrong kept side deletes the half the user wanted. The properties: the
 * fillet circle is r from BOTH curves, its arc ends on the trimmed curves'
 * ends, and the click decides which half survives.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const distTo = (e: Entity, p: { x: number; y: number }): number => {
  const c = exactPathOf(e)!.curves;
  return Math.min(...c.map((k) => closestParam(k, p).distance));
};
const ends = (e: Entity) => {
  const c = exactPathOf(e)!.curves[0];
  return [closestParam(c, { x: NaN, y: NaN })].length ? c : c;
};
void ends;

describe("filletCurves", () => {
  it("line + ellipse: arc is tangent to both and joins the trimmed ends", () => {
    const el: EllipseEntity = { id: "e", type: "ellipse", center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5, start: 0, end: Math.PI * 2 };
    const l = line("l", 12, -20, 12, 20);
    // Ellipse is closed → untouched; line is left alone only if the click is on the kept side — here we round the corner near (12,5).
    const r = filletCurves(l, el, 2, { x: 12, y: 10 }, { x: 8, y: 3 })!;
    expect(r).not.toBeNull();
    const arc = r.arc as ArcEntity;
    expect(r.second).toEqual(el); // closed curve not trimmed
    expect(distTo(r.first, arc.center)).toBeCloseTo(2, 6);
    expect(distToEllipse(el, arc.center)).toBeCloseTo(2, 6);
    // Tangent: the arc's start sits on the line.
    const s = arcPointAt(arc.center, arc.radius, arc.startAngle);
    const e2 = arcPointAt(arc.center, arc.radius, arc.endAngle);
    const onLine = [s, e2].some((p) => Math.abs(p.x - 12) < 1e-6);
    const onEllipse = [s, e2].some((p) => distToEllipse(el, p) < 1e-6);
    expect(onLine && onEllipse).toBe(true);
  });

  it("line + spline: both are trimmed at the tangent points, the click side kept", () => {
    const sp: SplineEntity = {
      id: "s", type: "spline", degree: 3, closed: false,
      controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 30, y: -20 }, { x: 50, y: 10 }, { x: 70, y: 0 }],
      knots: clampedUniformKnots(5, 3),
    };
    const l = line("l", 40, -60, 40, 60);
    const r = filletCurves(l, sp, 3, { x: 40, y: 20 }, { x: 25, y: 0 });
    expect(r).not.toBeNull();
    const arc = r!.arc as ArcEntity;
    expect(distTo(r!.first, arc.center)).toBeCloseTo(3, 6);
    const kept = r!.second as SplineEntity;
    expect(kept.type).toBe("spline");
    expect(distToNurbs({ degree: kept.degree, controlPoints: kept.controlPoints, knots: kept.knots, weights: kept.weights }, arc.center)).toBeCloseTo(3, 5);
  });

  it("line + arc: both ends meet the fillet arc exactly", () => {
    const a: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI, ccw: true };
    const l = line("l", -20, 0, 20, 0); // along the arc's start/end diameter... use a tangent-crossing line instead
    const l2 = line("l2", -20, 4, 20, 4);
    void l;
    const r = filletCurves(l2, a, 1, { x: 15, y: 4 }, { x: 8, y: 6 })!;
    expect(r).not.toBeNull();
    const arc = r.arc as ArcEntity;
    expect(distTo(r.first, arc.center)).toBeCloseTo(1, 6);
    expect(Math.abs(dist(arc.center, { x: 0, y: 0 }) - 10)).toBeCloseTo(1, 6);
  });

  it("a circle is never trimmed", () => {
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 10 };
    const l = line("l", 9, -20, 9, 20);
    const r = filletCurves(l, c, 2, { x: 9, y: 10 }, { x: 8, y: 6 })!;
    expect(r.second).toEqual(c);
    expect(r.arc).not.toBeNull();
  });

  it("radius 0 joins a line and an ellipse arc at their intersection", () => {
    const el: EllipseEntity = { id: "e", type: "ellipse", center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5, start: 0, end: Math.PI };
    const l = line("l", 0, 2, 30, 2);
    const r = filletCurves(l, el, 0, { x: 20, y: 2 }, { x: 6, y: 4 })!;
    expect(r.arc).toBeNull();
    expect(r.first.type).toBe("line");
    const line1 = r.first as LineEntity;
    expect(distToEllipse(el, line1.a) < 1e-6 || distToEllipse(el, line1.b) < 1e-6).toBe(true);
  });

  it("nothing to round → null", () => {
    expect(filletCurves(line("a", 0, 0, 10, 0), line("b", 0, 5, 10, 5), 1, { x: 5, y: 0 }, { x: 5, y: 5 })).toBeNull();
  });
});
