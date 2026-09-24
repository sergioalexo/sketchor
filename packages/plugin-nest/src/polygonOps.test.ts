import { describe, expect, it } from "vitest";
import { offsetPolygon } from "./polygonOps";
import { area } from "./geometry";

/**
 * Sanity checks that clipper2-js is actually wired up correctly (N-03) —
 * right units (mm in, mm out), right sign convention (positive = outward),
 * and that a delta severe enough to sever a shape doesn't throw.
 */

describe("offsetPolygon", () => {
  it("expands a square outward by a known amount", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const [result] = offsetPolygon(square, 2);
    expect(area(result)).toBeCloseTo(area([
      { x: -2, y: -2 },
      { x: 12, y: -2 },
      { x: 12, y: 12 },
      { x: -2, y: 12 },
    ]), 1);
  });

  it("shrinks a square inward by a known amount", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    const [result] = offsetPolygon(square, -3);
    expect(area(result)).toBeCloseTo(14 * 14, 0);
  });

  it("insetting past a shape's narrowest point empties the result rather than throwing", () => {
    const thin = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(() => offsetPolygon(thin, -10)).not.toThrow();
    const result = offsetPolygon(thin, -10);
    expect(result.every((loop) => area(loop) < 1e-6)).toBe(true);
  });

  it("insetting a dumbbell enough to sever its neck yields more than one loop", () => {
    // Two 10x10 lobes joined by a 1mm-wide, 10mm-long neck along y = 4.5..5.5.
    const dumbbell = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4.5 },
      { x: 20, y: 4.5 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 5.5 },
      { x: 10, y: 5.5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const result = offsetPolygon(dumbbell, -1);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});
