import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import type { EllipseEntity, PolylineEntity, SplineEntity } from "./entities";
import { curvesToPolylines, entityArea, entityLength } from "./curveMeasure";
import { findClosedRegions } from "./regions";
import { circleNurbs, clampedUniformKnots } from "./nurbs";

/**
 * Area and length of ellipses and splines come from the true curve (Green's
 * theorem / exact closed forms), not from a chord approximation; and
 * nesting/G-code get arc-fitted polylines instead of thousands of chords.
 */

const ellipse = (over: Partial<EllipseEntity> = {}): EllipseEntity => ({ id: "e", type: "ellipse", center: { x: 3, y: -2 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5, start: 0, end: Math.PI * 2, ...over });

describe("exact area and length", () => {
  it("full ellipse area is pi*a*b, independent of rotation and centre", () => {
    expect(entityArea(ellipse())).toBeCloseTo(Math.PI * 10 * 5, 9);
    expect(entityArea(ellipse({ majorAxis: { x: 6, y: 8 } }))).toBeCloseTo(Math.PI * 10 * 5, 9);
  });
  it("ellipse perimeter matches Ramanujan", () => {
    const a = 10, b = 5, h = ((a - b) / (a + b)) ** 2;
    expect(entityLength(ellipse())).toBeCloseTo(Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))), 3);
  });
  it("an open elliptical arc has a length but no area", () => {
    const arc = ellipse({ end: Math.PI });
    expect(entityArea(arc)).toBeNull();
    expect(entityLength(arc)!).toBeCloseTo(entityLength(ellipse())! / 2, 4);
  });
  it("a closed rational spline circle has area pi r^2", () => {
    const s = circleNurbs({ x: 1, y: 1 }, 4);
    const sp: SplineEntity = { id: "s", type: "spline", degree: s.degree, controlPoints: s.controlPoints, knots: s.knots, weights: s.weights, closed: true };
    expect(entityArea(sp)!).toBeCloseTo(Math.PI * 16, 6);
    expect(entityLength(sp)!).toBeCloseTo(2 * Math.PI * 4, 3);
  });
  it("a closed polynomial spline encloses a plausible area", () => {
    const cps = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
    const sp: SplineEntity = { id: "s", type: "spline", degree: 3, controlPoints: cps, knots: clampedUniformKnots(5, 3), closed: true };
    const a = entityArea(sp)!;
    expect(a).toBeGreaterThan(20);
    expect(a).toBeLessThan(100);
  });
  it("the closed-region finder reports an ellipse with its exact area", () => {
    const r = findClosedRegions([ellipse()]);
    expect(r).toHaveLength(1);
    expect(r[0].area).toBeCloseTo(Math.PI * 50, 9);
  });
});

describe("curvesToPolylines", () => {
  it("keeps the id and closes, with far fewer vertices than the chord chain", () => {
    const out = curvesToPolylines([ellipse()], 0.01)[0] as PolylineEntity;
    expect(out.type).toBe("polyline");
    expect(out.id).toBe("e");
    expect(out.closed).toBe(true);
    expect(out.points.length).toBeLessThan(200);
  });
  it("passes other entities through", () => {
    const c = { id: "c", type: "circle" as const, center: { x: 0, y: 0 }, radius: 1 };
    expect(curvesToPolylines([c], 0.01)[0]).toBe(c);
  });
});
