import { describe, expect, it } from "vitest";
import type { Entity, PolylineEntity } from "./entities";
import { polylineSegments } from "./entities";
import { bulgeToArc, dist } from "./geometry";
import { arcSlot, circleFrom2Points, circleFrom3Points, circleTangentToTwo, rectFrom3Points, rectFromCenter, regularPolygon, regularPolygonByEdge, straightSlot } from "./shapes";

/**
 * The draw-tool variants exist so a hole pattern, a hex nut or a slot is
 * one command instead of geometry gymnastics. Wrong here means a slot
 * whose caps bulge inward, a hexagon at the wrong across-flats size, a
 * tangent circle on the wrong side — all things a cutter would faithfully
 * reproduce.
 */

const onCircle = (c: { center: { x: number; y: number }; radius: number }, p: { x: number; y: number }) => Math.abs(dist(c.center, p) - c.radius) < 1e-9;

describe("circles", () => {
  it("2-point: the picks are diameter ends", () => {
    const c = circleFrom2Points({ x: 0, y: 0 }, { x: 10, y: 0 })!;
    expect(c.center).toEqual({ x: 5, y: 0 });
    expect(c.radius).toBe(5);
    expect(circleFrom2Points({ x: 1, y: 1 }, { x: 1, y: 1 })).toBeNull();
  });

  it("3-point passes through all three, null when collinear", () => {
    const c = circleFrom3Points({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 })!;
    expect(c.radius).toBeCloseTo(10, 9);
    expect(circleFrom3Points({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull();
  });

  it("tan-tan-radius picks the candidate on the clicked sides", () => {
    const h: Entity = { id: "h", type: "line", a: { x: -100, y: 0 }, b: { x: 100, y: 0 } };
    const v: Entity = { id: "v", type: "line", a: { x: 0, y: -100 }, b: { x: 0, y: 100 } };
    // Clicks in the first quadrant → center (5, 5).
    const c = circleTangentToTwo(h, v, 5, { x: 20, y: 1 }, { x: 1, y: 20 })!;
    expect(c.center.x).toBeCloseTo(5, 9);
    expect(c.center.y).toBeCloseTo(5, 9);
    // Third quadrant → (−5, −5).
    const d = circleTangentToTwo(h, v, 5, { x: -20, y: -1 }, { x: -1, y: -20 })!;
    expect(d.center.x).toBeCloseTo(-5, 9);
    expect(d.center.y).toBeCloseTo(-5, 9);
    // Tangent to a line and a circle: the center is r from the line and r from the circle's edge.
    const circle: Entity = { id: "c", type: "circle", center: { x: 0, y: 30 }, radius: 10 };
    // The gap between the line and the circle's bottom is 20, so r = 10 fits exactly at (0, 10).
    const t = circleTangentToTwo(h, circle, 10, { x: 1, y: 1 }, { x: 1, y: 19 })!;
    expect(t.center.x).toBeCloseTo(0, 6);
    expect(t.center.y).toBeCloseTo(10, 9);
    expect(dist(t.center, circle.center)).toBeCloseTo(20, 9);
    expect(circleTangentToTwo(h, circle, 5, { x: 8, y: 1 }, { x: 8, y: 22 })).toBeNull(); // r = 5 can't reach both
    expect(circleTangentToTwo(h, { ...h, id: "p", a: { x: -100, y: 50 }, b: { x: 100, y: 50 } }, 5, { x: 0, y: 1 }, { x: 0, y: 49 })).toBeNull(); // parallel lines 50 apart, r=5 can't bridge
  });
});

describe("rectangles", () => {
  it("center mode is symmetric about the center", () => {
    const r = rectFromCenter({ x: 10, y: 10 }, { x: 14, y: 12 })!;
    expect(r).toEqual([
      { x: 6, y: 8 },
      { x: 14, y: 8 },
      { x: 14, y: 12 },
      { x: 6, y: 12 },
    ]);
    expect(rectFromCenter({ x: 0, y: 0 }, { x: 5, y: 0 })).toBeNull();
  });

  it("3-point mode makes a rotated rectangle with the third point fixing the width side", () => {
    const r = rectFrom3Points({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 4 })!;
    // Edge along the diagonal, width = distance of (0,4) from that line = 4/√2 on the left.
    expect(dist(r[1], r[2])).toBeCloseTo(4 / Math.SQRT2, 9);
    expect(r[3].x).toBeCloseTo(-2, 9);
    expect(r[3].y).toBeCloseTo(2, 9);
    expect(rectFrom3Points({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 })).toBeNull();
  });
});

describe("regular polygons", () => {
  it("inscribed: the pick is a vertex; circumscribed: the pick is an edge midpoint", () => {
    const hexIn = regularPolygon({ x: 0, y: 0 }, { x: 10, y: 0 }, 6, true)!;
    expect(hexIn).toHaveLength(6);
    expect(hexIn[0]).toEqual({ x: 10, y: 0 });
    for (const p of hexIn) expect(dist(p, { x: 0, y: 0 })).toBeCloseTo(10, 9);
    const hexOut = regularPolygon({ x: 0, y: 0 }, { x: 10, y: 0 }, 6, false)!;
    // Across flats = 20: the edge midpoint between vertices 0 and 1 is (10, 0).
    const mid = { x: (hexOut[0].x + hexOut[1].x) / 2, y: (hexOut[0].y + hexOut[1].y) / 2 };
    expect(mid.x).toBeCloseTo(10, 9);
    expect(mid.y).toBeCloseTo(0, 9);
    expect(regularPolygon({ x: 0, y: 0 }, { x: 1, y: 0 }, 2, true)).toBeNull();
  });

  it("by edge: all edges equal the given one, turning counterclockwise", () => {
    const sq = regularPolygonByEdge({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)!;
    expect(sq).toHaveLength(4);
    expect(sq[2].x).toBeCloseTo(10, 9);
    expect(sq[2].y).toBeCloseTo(10, 9);
    for (let i = 0; i < 4; i++) expect(dist(sq[i], sq[(i + 1) % 4])).toBeCloseTo(10, 9);
  });
});

describe("slots", () => {
  const asPolyline = (s: { points: { x: number; y: number }[]; bulges: number[] }): PolylineEntity => ({ id: "s", type: "polyline", points: s.points, closed: true, bulges: s.bulges });

  it("a straight slot's caps are semicircles about the centres, bulging outward", () => {
    const s = straightSlot({ x: 0, y: 0 }, { x: 20, y: 0 }, 6)!;
    const segs = polylineSegments(asPolyline(s));
    const caps = segs.map((g) => bulgeToArc(g.a, g.b, g.bulge)).filter((a): a is NonNullable<typeof a> => !!a);
    expect(caps).toHaveLength(2);
    for (const cap of caps) expect(cap.radius).toBeCloseTo(3, 9);
    const centers = caps.map((c) => c.center.x).sort((a, b) => a - b);
    expect(centers[0]).toBeCloseTo(0, 9);
    expect(centers[1]).toBeCloseTo(20, 9);
    // Outward: the cap about (20,0) sweeps through (23, 0), not (17, 0).
    const right = caps.find((c) => Math.abs(c.center.x - 20) < 1e-9)!;
    const midAngle = right.ccw ? right.startAngle + Math.PI / 2 : right.startAngle - Math.PI / 2;
    expect(right.center.x + right.radius * Math.cos(midAngle)).toBeCloseTo(23, 9);
    expect(straightSlot({ x: 0, y: 0 }, { x: 0, y: 0 }, 6)).toBeNull();
  });

  it("an arc slot's caps sit on the centreline arc and bulge past its ends", () => {
    const s = arcSlot({ x: 0, y: 0 }, 10, 0, Math.PI / 2, 2)!;
    const segs = polylineSegments(asPolyline(s));
    const arcs = segs.map((g) => bulgeToArc(g.a, g.b, g.bulge)).filter((a): a is NonNullable<typeof a> => !!a);
    expect(arcs).toHaveLength(4);
    const outer = arcs.find((a) => Math.abs(a.radius - 11) < 1e-9)!;
    const inner = arcs.find((a) => Math.abs(a.radius - 9) < 1e-9)!;
    expect(outer.ccw).toBe(true);
    expect(inner.ccw).toBe(false);
    const caps = arcs.filter((a) => Math.abs(a.radius - 1) < 1e-9);
    expect(caps).toHaveLength(2);
    // The end cap is centred on the arc's end (0, 10) and passes through (−1, 10) — beyond the end.
    const endCap = caps.find((c) => Math.abs(c.center.y - 10) < 1e-9)!;
    expect(onCircle(endCap, { x: -1, y: 10 })).toBe(true);
    const midAngle = endCap.ccw ? endCap.startAngle + Math.PI / 2 : endCap.startAngle - Math.PI / 2;
    expect(endCap.center.x + endCap.radius * Math.cos(midAngle)).toBeCloseTo(-1, 9);
    expect(arcSlot({ x: 0, y: 0 }, 1, 0, 1, 4)).toBeNull(); // width bigger than the diameter
  });
});
