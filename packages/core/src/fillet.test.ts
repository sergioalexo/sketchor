import { describe, expect, it } from "vitest";
import type { LineEntity, PolylineEntity } from "./entities";
import { chamferLines, filletAllCorners, filletLines, filletPolylineCorner } from "./fillet";
import { arcPointAt, bulgeToArc, dist } from "./geometry";

/**
 * Fillet is the tool that turns two overshooting lines into a clean
 * corner, and rounds the corners of a plate outline before it goes to the
 * laser. A wrong "kept side" deletes the half of the line the user wanted;
 * a tangent point off by a hair leaves a kink the cutter will follow.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id,
  type: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});

describe("filletLines", () => {
  // Two lines forming an over-long "+": horizontal −10..10 on y=0, vertical −10..10 on x=0.
  const h = line("h", -10, 0, 10, 0);
  const v = line("v", 0, -10, 0, 10);

  it("radius 0 joins the clicked halves at the intersection", () => {
    const r = filletLines(h, v, 0, { x: 6, y: 0 }, { x: 0, y: 7 })!;
    expect(r.arc).toBeNull();
    expect(r.line1.a).toEqual({ x: 10, y: 0 });
    expect(r.line1.b).toEqual({ x: 0, y: 0 });
    expect(r.line2.a).toEqual({ x: 0, y: 10 });
    expect(r.line2.b).toEqual({ x: 0, y: 0 });
  });

  it("keeps whichever side was clicked", () => {
    const r = filletLines(h, v, 0, { x: -3, y: 0 }, { x: 0, y: -4 })!;
    expect(r.line1.a).toEqual({ x: -10, y: 0 });
    expect(r.line2.a).toEqual({ x: 0, y: -10 });
  });

  it("a radius gives an arc tangent to both lines at the right distance", () => {
    const r = filletLines(h, v, 3, { x: 6, y: 0 }, { x: 0, y: 7 })!;
    expect(r.line1.b.x).toBeCloseTo(3, 9);
    expect(r.line1.b.y).toBeCloseTo(0, 9);
    expect(r.line2.b.x).toBeCloseTo(0, 9);
    expect(r.line2.b.y).toBeCloseTo(3, 9);
    const a = r.arc!;
    expect(a.center.x).toBeCloseTo(3, 9);
    expect(a.center.y).toBeCloseTo(3, 9);
    expect(a.radius).toBe(3);
    // The arc runs from one tangent point to the other, the short way.
    expect(dist(arcPointAt(a.center, a.radius, a.startAngle), { x: 3, y: 0 })).toBeLessThan(1e-9);
    expect(dist(arcPointAt(a.center, a.radius, a.endAngle), { x: 0, y: 3 })).toBeLessThan(1e-9);
    const mid = arcPointAt(a.center, a.radius, a.ccw ? a.startAngle + Math.PI / 4 : a.startAngle - Math.PI / 4);
    expect(dist(mid, { x: 0, y: 0 })).toBeLessThan(3); // bulges toward the corner
  });

  it("extends lines that stop short of the corner", () => {
    const short1 = line("a", 2, 0, 10, 0);
    const short2 = line("b", 0, 2, 0, 10);
    const r = filletLines(short1, short2, 0, { x: 6, y: 0 }, { x: 0, y: 6 })!;
    expect(r.line1.b).toEqual({ x: 0, y: 0 });
    expect(r.line2.b).toEqual({ x: 0, y: 0 });
  });

  it("refuses parallel lines and a radius the lines cannot hold", () => {
    expect(filletLines(h, line("p", -10, 5, 10, 5), 1, { x: 0, y: 0 }, { x: 0, y: 5 })).toBeNull();
    expect(filletLines(h, v, 50, { x: 6, y: 0 }, { x: 0, y: 7 })).toBeNull();
  });
});

describe("chamferLines", () => {
  it("bevels the corner at the two distances", () => {
    const r = chamferLines(line("h", -10, 0, 10, 0), line("v", 0, -10, 0, 10), 2, 4, { x: 6, y: 0 }, { x: 0, y: 7 })!;
    expect(r.line1.b).toEqual({ x: 2, y: 0 });
    expect(r.line2.b).toEqual({ x: 0, y: 4 });
    expect(r.chamfer!.a).toEqual({ x: 2, y: 0 });
    expect(r.chamfer!.b).toEqual({ x: 0, y: 4 });
  });
});

describe("filletPolylineCorner / filletAllCorners", () => {
  const square: PolylineEntity = {
    id: "s",
    type: "polyline",
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    closed: true,
  };

  it("rounds one corner into two tangent points and an arc leg through the right quadrant", () => {
    const r = filletPolylineCorner(square, 1, 2)!; // corner (10,0)
    expect(r.points).toHaveLength(5);
    expect(r.points[1].x).toBeCloseTo(8, 9);
    expect(r.points[1].y).toBeCloseTo(0, 9);
    expect(r.points[2].x).toBeCloseTo(10, 9);
    expect(r.points[2].y).toBeCloseTo(2, 9);
    expect(r.bulges).toHaveLength(5);
    const arc = bulgeToArc(r.points[1], r.points[2], r.bulges![1])!;
    expect(arc.center.x).toBeCloseTo(8, 9);
    expect(arc.center.y).toBeCloseTo(2, 9);
    expect(arc.radius).toBeCloseTo(2, 9);
  });

  it("rounds every corner of a closed square, keeping it closed", () => {
    const r = filletAllCorners(square, 1);
    expect(r.points).toHaveLength(8);
    expect(r.closed).toBe(true);
    expect(r.bulges!.filter((b) => b !== 0)).toHaveLength(4);
  });

  it("leaves the open ends of an open polyline alone", () => {
    const open: PolylineEntity = { ...square, closed: false };
    expect(filletPolylineCorner(open, 0, 1)).toBeNull();
    expect(filletPolylineCorner(open, 3, 1)).toBeNull();
    expect(filletAllCorners(open, 1).points).toHaveLength(6);
  });

  it("refuses a radius the legs cannot hold, and corners that are already arcs", () => {
    expect(filletPolylineCorner(square, 1, 20)).toBeNull();
    const rounded = filletPolylineCorner(square, 1, 2)!;
    expect(filletPolylineCorner(rounded, 1, 1)).toBeNull();
  });
});
