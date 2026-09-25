import { describe, expect, it } from "vitest";
import { nfpKey, outerNfp } from "./nfp";
import { pointInPolygon } from "./geometry";

/**
 * NFP correctness is the one thing the whole placement search leans on —
 * a wrong NFP either overlaps parts silently or wastes sheet space forever.
 * These pin it against the textbook case (two squares) before anything
 * else is built on top of it, the same discipline that caught the
 * clipper2-js offset bug in Phase 0.
 */

describe("outerNfp", () => {
  it("two unit squares give the doubled square, centered on the origin", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const [loop] = outerNfp(square, square);
    const xs = loop.map((p) => p.x).sort((a, b) => a - b);
    const ys = loop.map((p) => p.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-1, 6);
    expect(xs[xs.length - 1]).toBeCloseTo(1, 6);
    expect(ys[0]).toBeCloseTo(-1, 6);
    expect(ys[ys.length - 1]).toBeCloseTo(1, 6);
  });

  it("doesn't depend on the input winding direction", () => {
    const ccw = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    const cw = [...ccw].reverse();
    const a = outerNfp(ccw, cw);
    const b = outerNfp(cw, ccw);
    // Both orderings describe the same NFP shape (stationary=ccw, orbiting=cw
    // vs. stationary=cw, orbiting=ccw are the same two physical squares).
    const boundsOf = (loops: { x: number; y: number }[][]) => {
      const pts = loops.flat();
      return {
        minX: Math.min(...pts.map((p) => p.x)),
        maxX: Math.max(...pts.map((p) => p.x)),
        minY: Math.min(...pts.map((p) => p.y)),
        maxY: Math.max(...pts.map((p) => p.y)),
      };
    };
    expect(boundsOf(a)).toEqual(boundsOf(b));
  });

  it("an off-origin reference point inside the NFP means real overlap", () => {
    // Two 10x10 squares: translating the second by (5,5) overlaps the first.
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const [loop] = outerNfp(square, square);
    expect(pointInPolygon({ x: 5, y: 5 }, loop)).toBe(true);
    expect(pointInPolygon({ x: 20, y: 20 }, loop)).toBe(false);
  });

  it("handles a concave shape without throwing", () => {
    const lShape = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 10 },
    ];
    const small = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(() => outerNfp(lShape, small)).not.toThrow();
    const loops = outerNfp(lShape, small);
    expect(loops.length).toBeGreaterThan(0);
  });
});

describe("nfpKey", () => {
  it("distinguishes part, rotation and mirror", () => {
    expect(nfpKey("a", 0, false)).not.toBe(nfpKey("b", 0, false));
    expect(nfpKey("a", 0, false)).not.toBe(nfpKey("a", 90, false));
    expect(nfpKey("a", 0, false)).not.toBe(nfpKey("a", 0, true));
  });
});
