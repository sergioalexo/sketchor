import { describe, expect, it } from "vitest";
import { innerFit, nfpKey, outerNfp } from "./nfp";
import { bounds, pointInPolygon, polygonContainsPolygon } from "./geometry";

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

describe("innerFit", () => {
  function square(w: number, h = w): { x: number; y: number }[] {
    return [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
  }

  it("a 10x10 square inside a 100x100 one gives exactly the [0,90]x[0,90] boundary", () => {
    const [loop] = innerFit(square(100), square(10));
    const b = bounds(loop);
    expect(b.minX).toBeCloseTo(0, 6);
    expect(b.minY).toBeCloseTo(0, 6);
    expect(b.maxX).toBeCloseTo(90, 6);
    expect(b.maxY).toBeCloseTo(90, 6);
  });

  it("a candidate translation from inside the region keeps the part fully inside the container", () => {
    const container = square(100);
    const part = square(10);
    const [loop] = innerFit(container, part);
    const candidate = { x: 40, y: 40 }; // well inside [0,90]x[0,90]
    const placed = part.map((p) => ({ x: p.x + candidate.x, y: p.y + candidate.y }));
    expect(pointInPolygon(candidate, loop)).toBe(true);
    expect(polygonContainsPolygon(container, placed)).toBe(true);
  });

  it("doesn't depend on the container's original winding direction", () => {
    const ccwContainer = square(100);
    const cwContainer = [...ccwContainer].reverse();
    const part = square(10);
    const a = bounds(innerFit(ccwContainer, part)[0]);
    const b = bounds(innerFit(cwContainer, part)[0]);
    expect(a).toEqual(b);
  });

  it("a part bigger than the container never verifies as actually contained (guards the technique's spurious-loop case)", () => {
    const container = square(100);
    const tooB1g = square(200);
    const loops = innerFit(container, tooB1g);
    // The technique can still emit a loop here — real callers must verify
    // with polygonContainsPolygon on the original container, not trust this
    // result alone. Confirm that verification correctly rejects it.
    for (const loop of loops) {
      for (const candidate of loop) {
        const placed = tooB1g.map((p) => ({ x: p.x + candidate.x, y: p.y + candidate.y }));
        expect(polygonContainsPolygon(container, placed)).toBe(false);
      }
    }
  });
});

describe("nfpKey", () => {
  it("distinguishes part, rotation and mirror", () => {
    expect(nfpKey("a", 0, false)).not.toBe(nfpKey("b", 0, false));
    expect(nfpKey("a", 0, false)).not.toBe(nfpKey("a", 90, false));
    expect(nfpKey("a", 0, false)).not.toBe(nfpKey("a", 0, true));
  });
});
