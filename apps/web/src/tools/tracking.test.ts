import { describe, expect, it } from "vitest";
import { applyTracking, trackingIncrement } from "./tracking";

/**
 * Ortho/polar decide where the second point of a line lands when the user
 * expects it to be exactly horizontal. If tracking let a grid snap through,
 * lines would come out a hair off-axis — the classic "why isn't this
 * square" DXF. And if it overrode an endpoint snap, you could never close
 * a shape with ortho on.
 */

const anchor = { x: 0, y: 0 };

describe("applyTracking", () => {
  it("does nothing without an anchor or with tracking off", () => {
    expect(applyTracking(null, { x: 3, y: 4 }, null, 90).point).toEqual({ x: 3, y: 4 });
    expect(applyTracking(anchor, { x: 3, y: 4 }, null, null).point).toEqual({ x: 3, y: 4 });
  });

  it("ortho projects onto the nearest axis, keeping the along-axis distance", () => {
    const r = applyTracking(anchor, { x: 10, y: 1 }, null, 90);
    expect(r.point.x).toBeCloseTo(10, 9);
    expect(r.point.y).toBeCloseTo(0, 9);
    expect(r.ray?.angleDeg).toBe(0);
    const up = applyTracking(anchor, { x: -0.5, y: 7 }, null, 90);
    expect(up.point.x).toBeCloseTo(0, 9);
    expect(up.point.y).toBeCloseTo(7, 9);
    expect(up.ray?.angleDeg).toBe(90);
  });

  it("polar snaps to the increment", () => {
    const r = applyTracking(anchor, { x: 10, y: 9 }, null, 45);
    expect(r.ray?.angleDeg).toBe(45);
    expect(r.point.x).toBeCloseTo(r.point.y, 9);
  });

  it("a feature snap the cursor touched beats tracking", () => {
    const r = applyTracking(anchor, { x: 10, y: 1 }, { point: { x: 10.2, y: 1.1 }, kind: "endpoint" }, 90);
    expect(r.point).toEqual({ x: 10.2, y: 1.1 });
    expect(r.ray).toBeNull();
  });

  it("a grid or on-line snap does not", () => {
    const r = applyTracking(anchor, { x: 10, y: 1 }, { point: { x: 10, y: 1 }, kind: "grid" }, 90);
    expect(r.point.y).toBeCloseTo(0, 9);
  });
});

describe("trackingIncrement", () => {
  it("Shift is temporary ortho; otherwise the settings decide", () => {
    expect(trackingIncrement({ ortho: false, polar: false, polarIncrement: 30 }, true)).toBe(90);
    expect(trackingIncrement({ ortho: false, polar: false, polarIncrement: 30 }, false)).toBeNull();
    expect(trackingIncrement({ ortho: true, polar: false, polarIncrement: 30 }, false)).toBe(90);
    expect(trackingIncrement({ ortho: false, polar: true, polarIncrement: 30 }, false)).toBe(30);
  });
});
