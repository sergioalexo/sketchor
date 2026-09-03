import { describe, expect, it } from "vitest";
import { area, bounds, insideSheet, normalize, polygonsClash, rotate } from "./geometry";
import type { Point } from "./types";

const square = (x: number, y: number, s: number): Point[] => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

describe("geometry", () => {
  it("area of a 10×10 square is 100", () => {
    expect(area(square(0, 0, 10))).toBeCloseTo(100);
  });

  it("normalize moves the bbox min to the origin", () => {
    const b = bounds(normalize(square(37, -12, 5)));
    expect(b.minX).toBeCloseTo(0);
    expect(b.minY).toBeCloseTo(0);
  });

  it("rotate 90° swaps the bbox extents", () => {
    const b = bounds(rotate([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 }, { x: 0, y: 2 }], 90));
    expect(b.maxX - b.minX).toBeCloseTo(2);
    expect(b.maxY - b.minY).toBeCloseTo(10);
  });

  it("polygonsClash: apart is clear, overlapping and within-gap are not", () => {
    expect(polygonsClash(square(0, 0, 10), square(20, 0, 10))).toBe(false);
    expect(polygonsClash(square(0, 0, 10), square(5, 5, 10))).toBe(true);
    expect(polygonsClash(square(0, 0, 10), square(13, 0, 10), 5)).toBe(true);
    expect(polygonsClash(square(0, 0, 10), square(16, 0, 10), 5)).toBe(false);
  });

  it("polygonsClash detects full containment", () => {
    expect(polygonsClash(square(0, 0, 20), square(5, 5, 3))).toBe(true);
  });

  it("insideSheet respects the inset", () => {
    expect(insideSheet(square(1, 1, 8), 10, 10, 1)).toBe(true);
    expect(insideSheet(square(0, 0, 10), 10, 10, 1)).toBe(false);
  });
});
