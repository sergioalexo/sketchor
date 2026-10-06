import { describe, expect, it } from "vitest";
import {
  bezierPieces,
  circleNurbs,
  clampedUniformKnots,
  closestNurbsParam,
  distToNurbs,
  insertKnot,
  interpolateNurbs,
  isClamped,
  isValidNurbs,
  nurbsBounds,
  nurbsDomain,
  nurbsEval,
  nurbsPointAt,
  splitNurbs,
  tessellateNurbs,
  type NurbsData,
} from "./nurbs";

/**
 * NURBS is the base of every spline feature: if evaluation, splitting or the
 * fit-point solve is off by a hair, a DXF spline imported from a customer's
 * file lands in the wrong place or a trim cuts the wrong part. These tests pin
 * the maths against curves with known answers (a true circle, a straight
 * line, an interpolation that must hit its points).
 */

const cubic: NurbsData = {
  degree: 3,
  controlPoints: [
    { x: 0, y: 0 },
    { x: 10, y: 30 },
    { x: 30, y: -20 },
    { x: 50, y: 10 },
    { x: 70, y: 0 },
    { x: 90, y: 25 },
  ],
  knots: clampedUniformKnots(6, 3),
};

const sample = (s: NurbsData, n = 40) => {
  const [lo, hi] = nurbsDomain(s);
  return Array.from({ length: n + 1 }, (_, i) => nurbsPointAt(s, lo + ((hi - lo) * i) / n));
};

describe("evaluation", () => {
  it("a clamped curve starts and ends on its end control points", () => {
    const [lo, hi] = nurbsDomain(cubic);
    expect(nurbsPointAt(cubic, lo)).toEqual({ x: 0, y: 0 });
    const end = nurbsPointAt(cubic, hi);
    expect(end.x).toBeCloseTo(90, 9);
    expect(end.y).toBeCloseTo(25, 9);
  });

  it("a degree-1 curve is its control polygon", () => {
    const line: NurbsData = { degree: 1, controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], knots: [0, 0, 1, 2, 2] };
    expect(nurbsPointAt(line, 0.5)).toEqual({ x: 5, y: 0 });
    expect(nurbsPointAt(line, 1.5)).toEqual({ x: 10, y: 5 });
  });

  it("the derivative agrees with a finite difference, rational or not", () => {
    for (const s of [cubic, circleNurbs({ x: 3, y: 4 }, 5)]) {
      const [lo, hi] = nurbsDomain(s);
      for (const f of [0.07, 0.31, 0.5, 0.77, 0.93]) {
        const u = lo + (hi - lo) * f;
        const h = 1e-6;
        const a = nurbsPointAt(s, u - h);
        const b = nurbsPointAt(s, u + h);
        const t = nurbsEval(s, u).tangent;
        expect(t.x).toBeCloseTo((b.x - a.x) / (2 * h), 4);
        expect(t.y).toBeCloseTo((b.y - a.y) / (2 * h), 4);
      }
    }
  });

  it("a rational quadratic is a true circle, not an approximation", () => {
    const c = circleNurbs({ x: 3, y: 4 }, 5);
    for (const p of sample(c, 200)) expect(Math.hypot(p.x - 3, p.y - 4)).toBeCloseTo(5, 9);
  });

  it("isValidNurbs rejects bad knot counts, decreasing knots, bad weights", () => {
    expect(isValidNurbs(cubic)).toBe(true);
    expect(isValidNurbs({ ...cubic, knots: cubic.knots.slice(1) })).toBe(false);
    expect(isValidNurbs({ ...cubic, knots: [0, 0, 0, 0, 2, 1, 3, 3, 3, 3] })).toBe(false);
    expect(isValidNurbs({ ...cubic, weights: [1, 1, 1, 1, 1, 0] })).toBe(false);
    expect(isValidNurbs({ ...cubic, controlPoints: cubic.controlPoints.slice(0, 3), knots: [0, 0, 0, 0, 1, 1, 1, 1] })).toBe(false);
  });
});

describe("knot insertion and splitting", () => {
  it("inserting a knot leaves the curve unchanged (polynomial and rational)", () => {
    for (const s of [cubic, circleNurbs({ x: 0, y: 0 }, 2)]) {
      const [lo, hi] = nurbsDomain(s);
      const more = insertKnot(insertKnot(s, lo + (hi - lo) * 0.37), lo + (hi - lo) * 0.81);
      expect(more.controlPoints.length).toBe(s.controlPoints.length + 2);
      for (const f of [0, 0.1, 0.37, 0.5, 0.81, 0.99, 1]) {
        const u = lo + (hi - lo) * f;
        const a = nurbsPointAt(s, u);
        const b = nurbsPointAt(more, u);
        expect(b.x).toBeCloseTo(a.x, 9);
        expect(b.y).toBeCloseTo(a.y, 9);
      }
    }
  });

  it("splitting yields two valid clamped curves that join at the split point and trace the original", () => {
    for (const s of [cubic, circleNurbs({ x: 0, y: 0 }, 2)]) {
      const [lo, hi] = nurbsDomain(s);
      for (const f of [0.2, 0.25, 0.6]) {
        const u = lo + (hi - lo) * f;
        const parts = splitNurbs(s, u)!;
        expect(parts).not.toBeNull();
        const [a, b] = parts;
        expect(isValidNurbs(a) && isValidNurbs(b)).toBe(true);
        expect(isClamped(a) && isClamped(b)).toBe(true);
        const [alo, ahi] = nurbsDomain(a);
        const [blo, bhi] = nurbsDomain(b);
        expect(alo).toBeCloseTo(lo, 12);
        expect(ahi).toBeCloseTo(u, 12);
        expect(blo).toBeCloseTo(u, 12);
        expect(bhi).toBeCloseTo(hi, 12);
        const join = nurbsPointAt(s, u);
        expect(nurbsPointAt(a, ahi).x).toBeCloseTo(join.x, 9);
        expect(nurbsPointAt(b, blo).y).toBeCloseTo(join.y, 9);
        for (const g of [0.1, 0.5, 0.9]) {
          const ua = alo + (ahi - alo) * g;
          const ub = blo + (bhi - blo) * g;
          expect(nurbsPointAt(a, ua).x).toBeCloseTo(nurbsPointAt(s, ua).x, 9);
          expect(nurbsPointAt(b, ub).y).toBeCloseTo(nurbsPointAt(s, ub).y, 9);
        }
      }
    }
  });

  it("refuses to split at the ends or an unclamped curve", () => {
    const [lo, hi] = nurbsDomain(cubic);
    expect(splitNurbs(cubic, lo)).toBeNull();
    expect(splitNurbs(cubic, hi)).toBeNull();
    const unclamped: NurbsData = { degree: 2, controlPoints: cubic.controlPoints.slice(0, 5), knots: [0, 1, 2, 3, 4, 5, 6, 7] };
    expect(isClamped(unclamped)).toBe(false);
    expect(splitNurbs(unclamped, 3.5)).toBeNull();
    expect(bezierPieces(unclamped)).toBeNull();
  });

  it("Bézier decomposition gives degree+1 points per piece and the same curve", () => {
    const pieces = bezierPieces(cubic)!;
    expect(pieces).toHaveLength(3); // 6 CVs, degree 3, uniform → 3 spans
    for (const pc of pieces) expect(pc.points).toHaveLength(4);
    // The first piece, evaluated as a Bézier, matches the curve on its span.
    const bz = (pts: { x: number; y: number }[], t: number) => {
      const [p0, p1, p2, p3] = pts;
      const m = 1 - t;
      return { x: m ** 3 * p0.x + 3 * m * m * t * p1.x + 3 * m * t * t * p2.x + t ** 3 * p3.x, y: m ** 3 * p0.y + 3 * m * m * t * p1.y + 3 * m * t * t * p2.y + t ** 3 * p3.y };
    };
    const [lo, hi] = nurbsDomain(cubic);
    const spanEnd = lo + (hi - lo) / 3;
    for (const t of [0.2, 0.5, 0.8]) {
      const want = nurbsPointAt(cubic, lo + (spanEnd - lo) * t);
      const got = bz(pieces[0].points, t);
      expect(got.x).toBeCloseTo(want.x, 9);
      expect(got.y).toBeCloseTo(want.y, 9);
    }
  });
});

describe("tessellation, bounds, distance", () => {
  it("chords stay within the tolerance of the curve", () => {
    const pts = tessellateNurbs(cubic, 0.02);
    for (let i = 0; i + 1 < pts.length; i++) {
      const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
      expect(distToNurbs(cubic, mid)).toBeLessThan(0.02 + 1e-6);
    }
    expect(pts[0]).toEqual({ x: 0, y: 0 });
  });

  it("a circle tessellates onto the circle and its bounds are its extents", () => {
    const c = circleNurbs({ x: 3, y: 4 }, 5);
    for (const p of tessellateNurbs(c, 0.01)) expect(Math.hypot(p.x - 3, p.y - 4)).toBeCloseTo(5, 9);
    const b = nurbsBounds(c);
    expect(b.minX).toBeCloseTo(-2, 4);
    expect(b.maxX).toBeCloseTo(8, 4);
    expect(b.minY).toBeCloseTo(-1, 4);
    expect(b.maxY).toBeCloseTo(9, 4);
  });

  it("bounds contain every sample and stay inside the control hull", () => {
    const b = nurbsBounds(cubic);
    for (const p of sample(cubic, 500)) {
      expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-9);
      expect(p.x).toBeLessThanOrEqual(b.maxX + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(b.minY - 1e-9);
      expect(p.y).toBeLessThanOrEqual(b.maxY + 1e-9);
    }
    expect(b.minY).toBeGreaterThanOrEqual(-20);
    expect(b.maxY).toBeLessThanOrEqual(30);
  });

  it("closest point: zero on the curve, the radial gap off a circle", () => {
    const c = circleNurbs({ x: 0, y: 0 }, 5);
    expect(distToNurbs(c, { x: 8, y: 0 })).toBeCloseTo(3, 6);
    expect(distToNurbs(c, { x: 0, y: 1 })).toBeCloseTo(4, 6);
    const on = nurbsPointAt(cubic, 0.37 * 3);
    expect(distToNurbs(cubic, on)).toBeLessThan(1e-7);
    const u = closestNurbsParam(cubic, on);
    expect(u).toBeCloseTo(0.37 * 3, 5);
  });
});

describe("interpolateNurbs (fit points)", () => {
  const fit = [
    { x: 0, y: 0 },
    { x: 10, y: 8 },
    { x: 25, y: 3 },
    { x: 40, y: -6 },
    { x: 55, y: 4 },
    { x: 70, y: 0 },
  ];

  it("passes through every fit point and is a valid clamped cubic", () => {
    const s = interpolateNurbs(fit)!;
    expect(s.degree).toBe(3);
    expect(isValidNurbs(s) && isClamped(s)).toBe(true);
    for (const p of fit) expect(distToNurbs(s, p)).toBeLessThan(1e-6);
    expect(nurbsPointAt(s, 0)).toEqual(fit[0]);
    expect(nurbsPointAt(s, 1).x).toBeCloseTo(70, 9);
  });

  it("reduces the degree for few points; two points make a straight line", () => {
    expect(interpolateNurbs(fit.slice(0, 3))!.degree).toBe(2);
    const line = interpolateNurbs([{ x: 0, y: 0 }, { x: 10, y: 5 }])!;
    expect(line.degree).toBe(1);
    const mid = nurbsPointAt(line, 0.5);
    expect(mid.x).toBeCloseTo(5, 9);
    expect(mid.y).toBeCloseTo(2.5, 9);
  });

  it("drops consecutive duplicates and rejects fewer than two distinct points", () => {
    expect(interpolateNurbs([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toBeNull();
    expect(interpolateNurbs([])).toBeNull();
    const s = interpolateNurbs([fit[0], fit[0], fit[1], fit[2]])!;
    expect(s.controlPoints).toHaveLength(3);
  });

  it("points on a straight line stay a straight line (no wiggle)", () => {
    const s = interpolateNurbs([0, 1, 2, 3, 4].map((i) => ({ x: i * 10, y: i * 5 })))!;
    for (const p of sample(s, 50)) expect(p.y).toBeCloseTo(p.x / 2, 6);
  });
});
