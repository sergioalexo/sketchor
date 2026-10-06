import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import type { CircleEntity, EllipseEntity, Entity, LineEntity, SplineEntity } from "./entities";
import { exactPathOf, extendTo, intersectCurves, joinNurbs, perpendicularTangentPoints, pointAt, splitAt, trimAt } from "./intersect";
import { distToEllipse } from "./ellipse";
import { circleNurbs, clampedUniformKnots, distToNurbs, nurbsDomain, nurbsPointAt, splitNurbs, type NurbsData } from "./nurbs";

/**
 * Trim, split and extend used to see an ellipse or spline as a chain of
 * 0.05 mm segments: a trimmed ellipse came back as a polyline with hundreds of
 * vertices and the cut landed on a chord, not the curve. These tests pin that
 * the exact curves intersect to a point that lies on BOTH curves, and that
 * what is left after a cut is still one ellipse / one spline tracing the
 * original — the property, not a literal.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const ellipse = (over: Partial<EllipseEntity> = {}): EllipseEntity => ({ id: "e", type: "ellipse", center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5, start: 0, end: Math.PI * 2, ...over });
const spline = (): SplineEntity => ({
  id: "s",
  type: "spline",
  degree: 3,
  controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 30, y: -20 }, { x: 50, y: 10 }, { x: 70, y: 0 }],
  knots: clampedUniformKnots(5, 3),
  closed: false,
});
const nurbsOf = (s: SplineEntity): NurbsData => ({ degree: s.degree, controlPoints: s.controlPoints, knots: s.knots, ...(s.weights ? { weights: s.weights } : {}) });

describe("exact ellipse / NURBS intersections", () => {
  it("finds the two points where a line crosses an ellipse's major axis", () => {
    const e = exactPathOf(ellipse())!.curves[0];
    const l = exactPathOf(line("l", -20, 0, 20, 0))!.curves[0];
    const hits = intersectCurves(e, l);
    expect(hits).toHaveLength(2);
    const xs = hits.map((h) => h.point.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-10, 8);
    expect(xs[1]).toBeCloseTo(10, 8);
  });

  it("an ellipse meets a circle at four points, each on both curves", () => {
    const circle: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 7 };
    const hits = intersectCurves(exactPathOf(ellipse())!.curves[0], exactPathOf(circle)!.curves[0]);
    expect(hits).toHaveLength(4);
    for (const h of hits) {
      expect(Math.hypot(h.point.x, h.point.y)).toBeCloseTo(7, 8);
      expect(distToEllipse(ellipse(), h.point)).toBeLessThan(1e-8);
    }
  });

  it("a spline crossing a line: hit lies on the spline and the parameters reproduce it", () => {
    const sp = exactPathOf(spline())!.curves[0];
    const l = exactPathOf(line("l", -5, 4, 80, 4))!.curves[0];
    const hits = intersectCurves(sp, l);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.point.y).toBeCloseTo(4, 8);
      expect(distToNurbs(nurbsOf(spline()), h.point)).toBeLessThan(1e-8);
      const back = pointAt(sp, h.t1);
      expect(Math.hypot(back.x - h.point.x, back.y - h.point.y)).toBeLessThan(1e-8);
    }
  });

  it("a rational circle spline and a line through its centre meet at ±r", () => {
    const hits = intersectCurves({ kind: "nurbs", s: circleNurbs({ x: 0, y: 0 }, 5) }, exactPathOf(line("l", -9, 0, 9, 0))!.curves[0]);
    expect(hits).toHaveLength(2);
    for (const h of hits) expect(Math.abs(h.point.x)).toBeCloseTo(5, 6);
  });

  it("two crossing splines: every hit is on both", () => {
    const a = spline();
    const b: SplineEntity = { ...spline(), id: "b", controlPoints: a.controlPoints.map((p) => ({ x: p.x, y: -p.y + 5 })) };
    const hits = intersectCurves(exactPathOf(a)!.curves[0], exactPathOf(b)!.curves[0]);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(distToNurbs(nurbsOf(a), h.point)).toBeLessThan(1e-7);
      expect(distToNurbs(nurbsOf(b), h.point)).toBeLessThan(1e-7);
    }
  });

  it("a line that misses the ellipse yields nothing", () => {
    expect(intersectCurves(exactPathOf(ellipse())!.curves[0], exactPathOf(line("l", -20, 9, 20, 9))!.curves[0])).toHaveLength(0);
  });
});

describe("trim / split / extend keep an exact ellipse or spline", () => {
  it("trimming a full ellipse leaves ONE ellipse that traces the original (not a polyline)", () => {
    const e = ellipse();
    const res = trimAt(e, [line("l", 0, -20, 0, 20)], { x: 10, y: 0 })!;
    expect(res.pieces).toHaveLength(1);
    const piece = res.pieces[0] as EllipseEntity;
    expect(piece.type).toBe("ellipse");
    // Left half only: the arc passes through (-10, 0) and not (10, 0).
    expect(distToEllipse(piece, { x: -10, y: 0 })).toBeLessThan(1e-8);
    expect(distToEllipse(piece, { x: 10, y: 0 })).toBeGreaterThan(5);
    // Both ends sit on the cutter, at (0, ±5).
    for (const t of [piece.start, piece.end]) {
      const p = {
        x: piece.center.x + piece.majorAxis.x * Math.cos(t) - piece.majorAxis.y * piece.ratio * Math.sin(t),
        y: piece.center.y + piece.majorAxis.y * Math.cos(t) + piece.majorAxis.x * piece.ratio * Math.sin(t),
      };
      expect(Math.abs(p.x)).toBeLessThan(1e-8);
      expect(Math.abs(Math.abs(p.y) - 5)).toBeLessThan(1e-8);
    }
  });

  it("trimming an open ellipse arc keeps the far piece as an ellipse", () => {
    const e = ellipse({ start: 0, end: Math.PI }); // upper half
    const res = trimAt(e, [line("l", 0, -20, 0, 20)], { x: 8, y: 2 })!;
    expect(res.pieces).toHaveLength(1);
    expect(res.pieces[0].type).toBe("ellipse");
    expect(distToEllipse(res.pieces[0] as EllipseEntity, { x: -10, y: 0 })).toBeLessThan(1e-8);
  });

  it("splitting a spline gives two splines that together trace the original", () => {
    const s = spline();
    const parts = splitAt(s, { x: 35, y: -5 })!;
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.type === "spline")).toBe(true);
    const [lo, hi] = nurbsDomain(nurbsOf(s));
    for (let i = 0; i <= 40; i++) {
      const q = nurbsPointAt(nurbsOf(s), lo + ((hi - lo) * i) / 40);
      const d = Math.min(...parts.map((p) => distToNurbs(nurbsOf(p as SplineEntity), q)));
      expect(d).toBeLessThan(1e-7);
    }
  });

  it("trimming a spline at a line removes only the clicked side", () => {
    const s = spline();
    const cutter = line("l", 35, -50, 35, 50);
    const res = trimAt(s, [cutter], { x: 60, y: 5 })!;
    expect(res.pieces).toHaveLength(1);
    const kept = res.pieces[0] as SplineEntity;
    expect(kept.type).toBe("spline");
    expect(distToNurbs(nurbsOf(kept), nurbsPointAt(nurbsOf(s), 0.05))).toBeLessThan(1e-7);
    expect(distToNurbs(nurbsOf(kept), { x: 70, y: 0 })).toBeGreaterThan(10);
    const k = nurbsOf(kept);
    expect(nurbsPointAt(k, nurbsDomain(k)[1]).x).toBeCloseTo(35, 7);
  });

  it("extends an ellipse arc round its own ellipse to a boundary line", () => {
    const e = ellipse({ start: 0.2, end: 1.2 });
    const res = extendTo(e, [line("m", 0, -20, 0, 20)], { x: 0, y: 5 }) as EllipseEntity | null;
    expect(res).not.toBeNull();
    expect(res!.type).toBe("ellipse");
    // The end nearest the click is at param 1.2; the vertical line meets the ellipse at param π/2.
    expect(res!.end).toBeCloseTo(Math.PI / 2, 6);
    expect(res!.start).toBeCloseTo(0.2, 9);
  });

  it("a spline has no extension past its end", () => {
    expect(extendTo(spline(), [line("l", 100, -50, 100, 50)], { x: 70, y: 0 })).toBeNull();
  });
});

describe("closed curves wrap across the seam", () => {
  const circleSpline = (): SplineEntity => {
    const n = circleNurbs({ x: 0, y: 0 }, 5);
    return { id: "cs", type: "spline", degree: n.degree, controlPoints: n.controlPoints, knots: n.knots, weights: n.weights, closed: true };
  };

  it("trimming a closed spline across its start point leaves ONE spline on the kept side", () => {
    const c = circleSpline();
    // The circle starts at (5, 0); a vertical cutter at x = 3 cuts it either side of the seam.
    const res = trimAt(c, [line("l", 3, -20, 3, 20)], { x: 5, y: 0 })!;
    expect(res.pieces).toHaveLength(1);
    const kept = res.pieces[0] as SplineEntity;
    expect(kept.type).toBe("spline");
    expect(distToNurbs(nurbsOf(kept), { x: -5, y: 0 })).toBeLessThan(1e-6);
    expect(distToNurbs(nurbsOf(kept), { x: 5, y: 0 })).toBeGreaterThan(1);
    // Everything kept is still on the circle.
    const k = nurbsOf(kept);
    const [lo, hi] = nurbsDomain(k);
    for (let i = 0; i <= 30; i++) {
      const p = nurbsPointAt(k, lo + ((hi - lo) * i) / 30);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 6);
    }
  });

  it("splitting a closed ellipse opens it into one full-turn ellipse starting at the click", () => {
    const parts = splitAt(ellipse(), { x: 0, y: 5 })!;
    expect(parts).toHaveLength(1);
    const e = parts[0] as EllipseEntity;
    expect(e.type).toBe("ellipse");
    expect(e.end - e.start).toBeCloseTo(Math.PI * 2, 9);
    expect(e.start).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe("joinNurbs", () => {
  it("rejoining the halves of a split reproduces the curve exactly (incl. rational)", () => {
    for (const s of [nurbsOf(spline()), circleNurbs({ x: 3, y: 2 }, 5)]) {
      const [lo, hi] = nurbsDomain(s);
      const [a, b] = splitNurbs(s, lo + (hi - lo) * 0.37)!;
      const j = joinNurbs(a, b)!;
      expect(j).not.toBeNull();
      const [jl, jh] = nurbsDomain(j);
      for (let i = 0; i <= 50; i++) {
        const q = nurbsPointAt(j, jl + ((jh - jl) * i) / 50);
        expect(distToNurbs(s, q)).toBeLessThan(1e-7);
      }
    }
  });
});

describe("regression: other entities unchanged", () => {
  it("exactPathOf of a polyline is the ordinary segment path", () => {
    const e: Entity = { id: "p", type: "polyline", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], closed: false };
    expect(exactPathOf(e)!.curves.every((c) => c.kind === "segment")).toBe(true);
  });
});

describe("perpendicular / tangent points on exact curves", () => {
  it("ellipse: the perpendicular feet are normal to the curve, the tangent points graze it", () => {
    const path = exactPathOf(ellipse())!;
    const c = path.curves[0] as Extract<(typeof path.curves)[number], { kind: "ellipse" }>;
    const from = { x: 20, y: 8 };
    const { perpendicular, tangent } = perpendicularTangentPoints(c, from);
    expect(tangent).toHaveLength(2);
    expect(perpendicular.length).toBeGreaterThanOrEqual(2);
    for (const p of [...perpendicular, ...tangent]) expect(distToEllipse(c.e, p)).toBeLessThan(1e-6);
    // Tangent point: the ellipse equation's polar line passes through `from` (x·x0/a² + y·y0/b² = 1).
    for (const p of tangent) expect(p.x * from.x / 100 + p.y * from.y / 25).toBeCloseTo(1, 5);
    // Perpendicular: the closest point is one of the feet.
    const closest = Math.min(...perpendicular.map((p) => Math.hypot(p.x - from.x, p.y - from.y)));
    expect(closest).toBeLessThan(Math.hypot(from.x - 10, from.y));
  });

  it("a tangent from inside an ellipse does not exist", () => {
    const c = exactPathOf(ellipse())!.curves[0];
    if (c.kind !== "ellipse") throw new Error("expected an ellipse curve");
    expect(perpendicularTangentPoints(c, { x: 1, y: 1 }).tangent).toHaveLength(0);
  });

  it("spline: perpendicular feet satisfy (P−from)·T = 0", () => {
    const c = exactPathOf(spline())!.curves[0];
    if (c.kind !== "nurbs") throw new Error("expected a NURBS curve");
    const from = { x: 35, y: 40 };
    const { perpendicular } = perpendicularTangentPoints(c, from);
    expect(perpendicular.length).toBeGreaterThan(0);
    for (const p of perpendicular) {
      const d = distToNurbs(nurbsOf(spline()), p);
      expect(d).toBeLessThan(1e-6);
    }
  });
});
