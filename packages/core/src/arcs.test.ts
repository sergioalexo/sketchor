import { describe, expect, it } from "vitest";
import { arcFrom3Points, arcFromCenterStartEnd, bulgeFrom3Points, tangentArc } from "./arcs";
import { angleInSweep, arcPointAt, bulgeToArc, dist } from "./geometry";

/**
 * The arc tool turns three clicks into an ArcEntity through these. A wrong
 * sweep direction draws the 270° complement of the arc the user traced; a
 * wrong center puts the arc through the wrong points. Both are silent in a
 * drawing until something is cut to it, so the properties pinned here are
 * "the arc passes through the picks" and "it sweeps the way the picks go".
 */

const onArc = (arc: { center: { x: number; y: number }; radius: number }, p: { x: number; y: number }) =>
  Math.abs(dist(arc.center, p) - arc.radius) < 1e-9;

describe("arcFrom3Points", () => {
  it("passes through all three points, sweeping through the middle one", () => {
    const arc = arcFrom3Points({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 })!;
    expect(arc.center.x).toBeCloseTo(0, 9);
    expect(arc.center.y).toBeCloseTo(0, 9);
    expect(arc.radius).toBeCloseTo(10, 9);
    expect(arc.ccw).toBe(true);
    expect(angleInSweep(Math.PI / 2, arc.startAngle, arc.endAngle, arc.ccw)).toBe(true);
    expect(angleInSweep(-Math.PI / 2, arc.startAngle, arc.endAngle, arc.ccw)).toBe(false);
  });

  it("goes the other way round when the via point is on the other side", () => {
    const arc = arcFrom3Points({ x: 10, y: 0 }, { x: 0, y: -10 }, { x: -10, y: 0 })!;
    expect(arc.ccw).toBe(false);
    expect(angleInSweep(-Math.PI / 2, arc.startAngle, arc.endAngle, arc.ccw)).toBe(true);
  });

  it("returns null for collinear or coincident points", () => {
    expect(arcFrom3Points({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 })).toBeNull();
    expect(arcFrom3Points({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 })).toBeNull();
  });
});

describe("arcFromCenterStartEnd", () => {
  it("takes the radius from the start and only the angle from the end", () => {
    const arc = arcFromCenterStartEnd({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 20 })!;
    expect(arc.radius).toBeCloseTo(5, 9);
    expect(arc.endAngle).toBeCloseTo(Math.PI / 2, 9);
    expect(arc.ccw).toBe(true);
    expect(onArc(arc, arcPointAt(arc.center, arc.radius, arc.endAngle))).toBe(true);
  });

  it("rejects a start on the center and a zero sweep", () => {
    expect(arcFromCenterStartEnd({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeNull();
    expect(arcFromCenterStartEnd({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 })).toBeNull();
  });
});

describe("tangentArc", () => {
  it("is tangent to the given direction at the start and ends at the end", () => {
    // Heading +X from the origin, ending at (10, 10): a quarter circle of r=10 about (0, 10).
    const arc = tangentArc({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 10, y: 10 })!;
    expect(arc.center.x).toBeCloseTo(0, 9);
    expect(arc.center.y).toBeCloseTo(10, 9);
    expect(arc.radius).toBeCloseTo(10, 9);
    expect(arc.ccw).toBe(true);
    expect(onArc(arc, { x: 0, y: 0 })).toBe(true);
    expect(onArc(arc, { x: 10, y: 10 })).toBe(true);
    // Tangent at the start: the radius there is perpendicular to +X.
    const r0 = { x: 0 - arc.center.x, y: 0 - arc.center.y };
    expect(Math.abs(r0.x * 1 + r0.y * 0)).toBeLessThan(1e-9);
  });

  it("turns the other way for an end on the other side", () => {
    const arc = tangentArc({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 10, y: -10 })!;
    expect(arc.ccw).toBe(false);
    expect(arc.center.y).toBeCloseTo(-10, 9);
  });

  it("returns null for an end on the tangent line (a straight continuation)", () => {
    expect(tangentArc({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 10, y: 0 })).toBeNull();
    expect(tangentArc({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 5 })).toBeNull();
  });
});

describe("bulgeFrom3Points", () => {
  it("round-trips through bulgeToArc for a minor and a major arc", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    for (const via of [
      { x: 5, y: 2 }, // minor, ccw (above the chord, center below)
      { x: 5, y: -2 }, // minor, cw
      { x: 5, y: 9 }, // major, ccw
    ]) {
      const bulge = bulgeFrom3Points(a, via, b);
      const back = bulgeToArc(a, b, bulge)!;
      expect(back).not.toBeNull();
      expect(onArc(back, via)).toBe(true);
      const expected = arcFrom3Points(a, via, b)!;
      expect(back.center.x).toBeCloseTo(expected.center.x, 6);
      expect(back.center.y).toBeCloseTo(expected.center.y, 6);
      expect(back.ccw).toBe(expected.ccw);
    }
  });

  it("is zero for a straight leg", () => {
    expect(bulgeFrom3Points({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })).toBe(0);
  });
});
