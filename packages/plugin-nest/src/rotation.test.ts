import { describe, expect, it } from "vitest";
import { minimumBoundingBoxAngle, rotationCandidates } from "./rotation";
import { bounds, rotate } from "./geometry";

describe("minimumBoundingBoxAngle", () => {
  it("recovers the axis of a rectangle rotated by an odd angle", () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 5 },
      { x: 0, y: 5 },
    ];
    const rotated = rotate(rect, 37);
    const deg = minimumBoundingBoxAngle(rotated);
    // Rotating the recovered angle back should give (close to) the original axis-aligned box area.
    const back = bounds(rotate(rotated, deg));
    const area = (back.maxX - back.minX) * (back.maxY - back.minY);
    expect(area).toBeCloseTo(20 * 5, 6);
  });

  it("an already axis-aligned square needs no rotation", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(minimumBoundingBoxAngle(square)).toBeCloseTo(0, 6);
  });
});

describe("rotationCandidates", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("locked mode is just [0]", () => {
    expect(rotationCandidates({ mode: "locked" }, square)).toEqual([{ deg: 0, mirrored: false }]);
  });

  it("quarter mode is the four right angles", () => {
    const degs = rotationCandidates({ mode: "quarter" }, square).map((c) => c.deg);
    expect(degs).toEqual([0, 90, 180, 270]);
  });

  it("any mode sweeps the step grid and includes the bbox-optimal angle", () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 5 },
      { x: 0, y: 5 },
    ];
    const rotated = rotate(rect, 37);
    const candidates = rotationCandidates({ mode: "any", stepDeg: 90 }, rotated);
    const degs = candidates.map((c) => c.deg);
    expect(degs).toContain(0);
    expect(degs).toContain(90);
    expect(degs).toContain(180);
    expect(degs).toContain(270);
    const bboxDeg = minimumBoundingBoxAngle(rotated);
    expect(degs.some((d) => Math.abs(d - bboxDeg) < 1e-6)).toBe(true);
  });

  it("doubles every candidate when mirror is set", () => {
    const withMirror = rotationCandidates({ mode: "quarter", mirror: true }, square);
    expect(withMirror).toHaveLength(8);
    expect(withMirror.filter((c) => c.mirrored)).toHaveLength(4);
    expect(withMirror.filter((c) => !c.mirrored)).toHaveLength(4);
  });

  it("floors the step at 1 degree", () => {
    const candidates = rotationCandidates({ mode: "any", stepDeg: 0 }, square);
    // 360 steps of 1 degree, plus possibly the (already-present) bbox angle.
    expect(candidates.length).toBeGreaterThanOrEqual(360);
  });
});
