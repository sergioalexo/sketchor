import { describe, expect, it } from "vitest";
import { nestTrueShape, type TrueNestPart } from "./trueNest";
import type { StockRow } from "./stock";
import { normalize, polygonsClash, rotate, translate, insideSheet } from "./geometry";
import type { Point } from "./types";

/**
 * N-15's invariants, minus the hole-fill case (that's N-12, not built yet):
 * no overlap and everything inside its sheet hold no matter what the search
 * placed, locked rotation is actually respected, stock quantity limits are
 * enforced, and an oversized part is reported rather than looping forever.
 */

function rect(w: number, h: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

function lShape(): Point[] {
  return [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
    { x: 5, y: 5 },
    { x: 5, y: 10 },
    { x: 0, y: 10 },
  ];
}

/** Rebuilds the world-space polygon a placement describes, mirroring trueNest.ts's own localFrame(). */
function materialize(outer: Point[], placement: { rotationDeg: number; mirrored: boolean; translation: Point }): Point[] {
  const mirroredPoly = placement.mirrored ? outer.map((p) => ({ x: -p.x, y: p.y })) : outer;
  const local = normalize(rotate(mirroredPoly, placement.rotationDeg));
  return translate(local, placement.translation.x, placement.translation.y);
}

/** Small deterministic PRNG so the randomized invariant test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("nestTrueShape", () => {
  it("places non-overlapping shapes entirely inside their sheet (randomised rectangles + an L-shape)", () => {
    const rand = mulberry32(42);
    const parts: TrueNestPart[] = [];
    for (let i = 0; i < 8; i++) {
      const w = 10 + Math.floor(rand() * 30);
      const h = 10 + Math.floor(rand() * 30);
      parts.push({
        id: `rect-${i}`,
        name: `Rect ${i}`,
        outer: rect(w, h),
        holes: [],
        quantity: 1 + Math.floor(rand() * 2),
        rotation: { mode: "quarter" },
      });
    }
    parts.push({ id: "L", name: "L", outer: lShape(), holes: [], quantity: 2, rotation: { mode: "quarter" } });

    const stock: StockRow[] = [{ size: { name: "sheet", width: 300, height: 300 }, qty: 6 }];
    const result = nestTrueShape(parts, stock, { spacing: 1 });

    expect(result.placed.length).toBeGreaterThan(0);

    const partById = new Map(parts.map((p) => [p.id, p]));
    const bySheet = new Map<number, { partId: string; polygon: Point[] }[]>();
    for (const placement of result.placed) {
      const part = partById.get(placement.partId)!;
      const polygon = materialize(part.outer, placement);
      const sheet = result.sheets[placement.sheet];
      expect(insideSheet(polygon, sheet.width, sheet.height, 0)).toBe(true);
      const list = bySheet.get(placement.sheet) ?? [];
      list.push({ partId: placement.partId, polygon });
      bySheet.set(placement.sheet, list);
    }
    for (const items of bySheet.values()) {
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          expect(polygonsClash(items[i].polygon, items[j].polygon, 0)).toBe(false);
        }
      }
    }
  });

  it("never rotates a locked part", () => {
    const parts: TrueNestPart[] = [
      { id: "p", name: "p", outer: rect(20, 8), holes: [], quantity: 6, rotation: { mode: "locked" } },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 3 }];
    const result = nestTrueShape(parts, stock);
    for (const placement of result.placed) {
      expect(placement.rotationDeg).toBe(0);
      expect(placement.mirrored).toBe(false);
    }
  });

  it("stops opening sheets once stock quantity is exhausted, reporting the rest unplaced", () => {
    const parts: TrueNestPart[] = [
      { id: "p", name: "p", outer: rect(80, 80), holes: [], quantity: 5, rotation: { mode: "locked" } },
    ];
    // Only 2 sheets of 100x100 exist — at most 2 of the 5 parts (one per sheet) can fit.
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 2 }];
    const result = nestTrueShape(parts, stock);
    expect(result.sheets.length).toBeLessThanOrEqual(2);
    expect(result.placed.length).toBeLessThanOrEqual(2);
    const unplacedCount = result.unplaced.find((u) => u.partId === "p")?.count ?? 0;
    expect(result.placed.length + unplacedCount).toBe(5);
    expect(unplacedCount).toBeGreaterThan(0);
  });

  it("reports a part bigger than every stock row as unplaced instead of throwing", () => {
    const parts: TrueNestPart[] = [
      { id: "huge", name: "huge", outer: rect(500, 500), holes: [], quantity: 1, rotation: { mode: "locked" } },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: null }];
    expect(() => nestTrueShape(parts, stock)).not.toThrow();
    const result = nestTrueShape(parts, stock);
    expect(result.placed).toHaveLength(0);
    expect(result.unplaced).toEqual([{ partId: "huge", count: 1 }]);
  });

  it("reports empty results for no parts without opening any sheet", () => {
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 1 }];
    const result = nestTrueShape([], stock);
    expect(result.sheets).toHaveLength(0);
    expect(result.placed).toHaveLength(0);
    expect(result.utilisation).toBe(0);
  });
});
