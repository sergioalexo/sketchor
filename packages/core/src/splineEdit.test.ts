import { describe, expect, it } from "vitest";
import type { PolylineEntity, SplineEntity } from "./entities";
import { interpolateNurbs, nurbsDomain, nurbsPointAt, distToNurbs } from "./nurbs";
import { addSplinePoint, polylineToSpline, rebuildSpline, removeSplinePoint, splineToControlPoints, splineToPolyline } from "./splineEdit";

const FIT = [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: -3 }, { x: 30, y: 5 }];
const fitSpline = (): SplineEntity => ({ id: "s", type: "spline", name: "S1", layer: "L", ...interpolateNurbs(FIT, 3)!, fitPoints: FIT, closed: false });

describe("spline editing", () => {
  it("convert to CVs drops only the fit data and keeps the curve", () => {
    const e = fitSpline();
    const cv = splineToControlPoints(e)!;
    expect(cv.fitPoints).toBeUndefined();
    expect(cv.controlPoints).toEqual(e.controlPoints);
    expect(splineToControlPoints(cv)).toBeNull();
  });

  it("adding a fit point puts it on the curve, in order, and the curve still passes through all of them", () => {
    const e = fitSpline();
    const s = addSplinePoint(e, { x: 15, y: 4 })!;
    expect(s.fitPoints).toHaveLength(5);
    const xs = s.fitPoints!.map((p) => p.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    for (const p of s.fitPoints!) expect(distToNurbs(s, p)).toBeLessThan(1e-6);
    expect(s.layer).toBe("L");
  });

  it("adding a control point by knot insertion leaves the shape unchanged", () => {
    const cv = splineToControlPoints(fitSpline())!;
    const s = addSplinePoint(cv, { x: 12, y: 3 })!;
    expect(s.controlPoints).toHaveLength(cv.controlPoints.length + 1);
    const [lo, hi] = nurbsDomain(cv);
    for (let i = 0; i <= 10; i++) {
      const p = nurbsPointAt(cv, lo + ((hi - lo) * i) / 10);
      expect(distToNurbs(s, p)).toBeLessThan(1e-9);
    }
  });

  it("removing a fit point refits through the rest; the last two can't be removed", () => {
    const s = removeSplinePoint(fitSpline(), 1)!;
    expect(s.fitPoints).toEqual([FIT[0], FIT[2], FIT[3]]);
    expect(distToNurbs(s, FIT[2])).toBeLessThan(1e-6);
    const two = removeSplinePoint(s, 1)!;
    expect(removeSplinePoint(two, 0)).toBeNull();
  });

  it("rebuild gives a plain cubic with the asked number of control points, close to the original", () => {
    const e = fitSpline();
    const r = rebuildSpline(e, 7)!;
    expect(r.controlPoints).toHaveLength(7);
    expect(r.fitPoints).toBeUndefined();
    expect(distToNurbs(r, FIT[1])).toBeLessThan(1);
    expect(distToNurbs(r, FIT[3])).toBeLessThan(1e-6);
  });

  it("polyline → spline passes through the vertices; closed ones meet", () => {
    const pl: PolylineEntity = { id: "p", type: "polyline", name: "P1", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], closed: true };
    const s = polylineToSpline(pl)!;
    expect(s.type).toBe("spline");
    expect(s.closed).toBe(true);
    expect(s.name).toBe("P1");
    for (const p of pl.points) expect(distToNurbs(s, p)).toBeLessThan(1e-6);
    const [lo, hi] = nurbsDomain(s);
    expect(nurbsPointAt(s, hi)).toEqual(nurbsPointAt(s, lo));
  });

  it("spline → polyline stays within tolerance of the curve", () => {
    const e = fitSpline();
    const pl = splineToPolyline(e, 0.05)!;
    expect(pl.type).toBe("polyline");
    expect(pl.name).toBe("S1");
    for (const p of pl.points) expect(distToNurbs(e, p)).toBeLessThan(0.06);
  });
});
