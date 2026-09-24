import { describe, expect, it } from "vitest";
import { flattenArc, flattenCircle, flattenClosedPolyline } from "./flatten";
import type { PolylineEntity } from "@sketchor/core";

/**
 * Chord-tolerance flattening feeds directly into nesting/containment math
 * (N-01): too coarse and a real overlap gets missed, too fine and a big
 * sheet-edge radius blows up the point count. These tests pin the one
 * contract that matters — every sampled chord stays within tolerance of the
 * true arc — across a spread of radii and sweeps, plus the degenerate cases
 * a hand-rolled sampler tends to divide-by-zero or infinite-loop on.
 */

function maxChordDeviation(center: { x: number; y: number }, radius: number, points: { x: number; y: number }[]): number {
  let worst = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    // Midpoint of the chord vs. the true arc at the same angular midpoint.
    const angA = Math.atan2(a.y - center.y, a.x - center.x);
    const angB = Math.atan2(b.y - center.y, b.x - center.x);
    let mid = (angA + angB) / 2;
    if (Math.abs(angA - angB) > Math.PI) mid += Math.PI; // wrap through 0
    const truePoint = { x: center.x + radius * Math.cos(mid), y: center.y + radius * Math.sin(mid) };
    const chordMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    worst = Math.max(worst, Math.hypot(truePoint.x - chordMid.x, truePoint.y - chordMid.y));
  }
  return worst;
}

describe("flattenArc", () => {
  it.each([1, 10, 100, 1000])("stays within chord tolerance for radius %d", (radius) => {
    const chordTol = 0.05;
    const points = flattenArc({ x: 0, y: 0 }, radius, 0, Math.PI * 1.3, true, chordTol);
    expect(maxChordDeviation({ x: 0, y: 0 }, radius, points)).toBeLessThanOrEqual(chordTol * 1.001);
  });

  it("includes both endpoints exactly", () => {
    const points = flattenArc({ x: 5, y: -2 }, 20, 0.3, 1.7, true, 0.05);
    expect(points[0]).toEqual({ x: 5 + 20 * Math.cos(0.3), y: -2 + 20 * Math.sin(0.3) });
    const last = points[points.length - 1];
    expect(last.x).toBeCloseTo(5 + 20 * Math.cos(0.3 + 1.7), 9);
    expect(last.y).toBeCloseTo(-2 + 20 * Math.sin(0.3 + 1.7), 9);
  });

  it("sweeps clockwise when ccw is false", () => {
    const points = flattenArc({ x: 0, y: 0 }, 10, Math.PI / 2, Math.PI / 2, false, 0.05);
    const last = points[points.length - 1];
    expect(last.x).toBeCloseTo(10, 6); // ends at angle 0
    expect(last.y).toBeCloseTo(0, 6);
  });

  it("doesn't divide by zero or hang on a zero-radius arc", () => {
    const points = flattenArc({ x: 1, y: 1 }, 0, 0, Math.PI, true, 0.05);
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("doesn't divide by zero or hang on a zero-sweep arc", () => {
    const points = flattenArc({ x: 0, y: 0 }, 10, 1, 0, true, 0.05);
    expect(points.length).toBe(1);
  });

  it("a tolerance larger than the radius still covers the whole sweep in one step", () => {
    const points = flattenArc({ x: 0, y: 0 }, 0.001, 0, Math.PI, true, 0.05);
    expect(points.length).toBe(2);
  });
});

describe("flattenCircle", () => {
  it("returns a closed loop without repeating the first point", () => {
    const points = flattenCircle({ x: 0, y: 0 }, 50, 0.05);
    expect(points.length).toBeGreaterThan(3);
    const first = points[0];
    const last = points[points.length - 1];
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeGreaterThan(1e-6);
    // Every point is on the circle.
    for (const p of points) expect(Math.hypot(p.x, p.y)).toBeCloseTo(50, 6);
  });
});

describe("flattenClosedPolyline", () => {
  it("keeps straight segments exact", () => {
    const square: PolylineEntity = {
      id: "pl1",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      closed: true,
    };
    const points = flattenClosedPolyline(square, 0.05);
    expect(points).toEqual(square.points);
  });

  it("flattens a bulged segment and doesn't repeat the closing vertex", () => {
    // A "D" shape: straight left edge, bulged right edge (semicircle bulge = 1).
    const shape: PolylineEntity = {
      id: "pl2",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ],
      bulges: [0, 1],
      closed: true,
    };
    const points = flattenClosedPolyline(shape, 0.05);
    expect(points.length).toBeGreaterThan(2);
    const first = points[0];
    const last = points[points.length - 1];
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeGreaterThan(1e-6);
    // The bulge is a semicircle of radius 5 centred at (0, 5) — some point
    // must actually deviate off the straight line x = 0 to prove it flattened.
    expect(Math.max(...points.map((p) => Math.abs(p.x)))).toBeCloseTo(5, 1);
  });
});
