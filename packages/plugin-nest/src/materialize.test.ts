import { describe, expect, it } from "vitest";
import type { ArcEntity, PolylineEntity } from "@sketchor/core";
import { materializeInstance } from "./materialize";

/**
 * The whole point of N-02 is that a placed instance keeps a *real* arc, not
 * a flattened approximation — so these tests check the output's analytic
 * arc/bulge parameters against applying the transform by hand, not just
 * that some points moved to plausible places.
 */

describe("materializeInstance", () => {
  it("rotates and translates an arc, updating center and angles analytically", () => {
    const arc: ArcEntity = {
      id: "a1",
      type: "arc",
      center: { x: 5, y: 0 },
      radius: 3,
      startAngle: 0,
      endAngle: Math.PI / 2,
      ccw: true,
    };
    const [out] = materializeInstance([arc], { rotationDeg: 90, translation: { x: 100, y: 200 } });
    expect(out.type).toBe("arc");
    const o = out as ArcEntity;
    // Rotating (5,0) by 90 deg about the origin -> (0,5), then + translation.
    expect(o.center.x).toBeCloseTo(100, 9);
    expect(o.center.y).toBeCloseTo(205, 9);
    expect(o.radius).toBe(3);
    expect(o.startAngle).toBeCloseTo(Math.PI / 2, 9);
    expect(o.endAngle).toBeCloseTo(Math.PI, 9);
    expect(o.ccw).toBe(true);
  });

  it("gives materialized entities fresh ids, even across repeated calls", () => {
    const arc: ArcEntity = {
      id: "a1",
      type: "arc",
      center: { x: 0, y: 0 },
      radius: 1,
      startAngle: 0,
      endAngle: 1,
      ccw: true,
    };
    const [first] = materializeInstance([arc], { rotationDeg: 0, translation: { x: 0, y: 0 } });
    const [second] = materializeInstance([arc], { rotationDeg: 0, translation: { x: 10, y: 0 } });
    expect(first.id).not.toBe(arc.id);
    expect(second.id).not.toBe(arc.id);
    expect(first.id).not.toBe(second.id);
  });

  it("mirrors a bulged polyline by negating its bulges, not just its points", () => {
    const shape: PolylineEntity = {
      id: "pl1",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      bulges: [0.5],
      closed: false,
    };
    const [out] = materializeInstance([shape], { rotationDeg: 0, translation: { x: 0, y: 0 }, mirrored: true });
    const o = out as PolylineEntity;
    expect(o.points[0]).toEqual({ x: 0, y: 0 });
    expect(o.points[1]).toEqual({ x: -10, y: 0 });
    expect(o.bulges?.[0]).toBe(-0.5);
  });

  it("mirror + rotate + translate composes in that order", () => {
    // A point at (1, 0): mirror -> (-1, 0); rotate 90 -> (0, -1); translate (0,0) -> (0, -1).
    const arc: ArcEntity = {
      id: "a1",
      type: "arc",
      center: { x: 1, y: 0 },
      radius: 2,
      startAngle: 0,
      endAngle: 1,
      ccw: true,
    };
    const [out] = materializeInstance([arc], { rotationDeg: 90, translation: { x: 0, y: 0 }, mirrored: true });
    const o = out as ArcEntity;
    expect(o.center.x).toBeCloseTo(0, 9);
    expect(o.center.y).toBeCloseTo(-1, 9);
  });
});
