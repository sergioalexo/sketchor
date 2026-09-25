import { describe, expect, it } from "vitest";
import { localFrame, nestTrueShape, placementTransform, type TrueNestPart } from "./trueNest";
import type { StockRow } from "./stock";
import { bounds, normalize, polygonsClash, rotate, translate, insideSheet } from "./geometry";
import type { Point } from "./types";

/**
 * N-15's invariants: no overlap and everything inside its sheet hold no
 * matter what the search placed, locked rotation is actually respected,
 * stock quantity limits are enforced, an oversized part is reported rather
 * than looping forever, and (N-12) a part flagged allowInHoles actually
 * lands inside another part's hole rather than being reported unplaced.
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

  it.each([
    ["bottom-left", { x: 0, y: 0 }],
    ["bottom-right", { x: 80, y: 0 }],
    ["top-left", { x: 0, y: 80 }],
    ["top-right", { x: 80, y: 80 }],
  ] as const)("gravity %s puts the first part in that sheet corner", (gravity, expected) => {
    const parts: TrueNestPart[] = [
      { id: "p", name: "p", outer: rect(20, 20), holes: [], quantity: 1, rotation: { mode: "locked" } },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 1 }];
    const result = nestTrueShape(parts, stock, { gravity });
    expect(result.placed).toHaveLength(1);
    expect(result.placed[0].translation).toEqual(expected);
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

  it("placementTransform, applied to the original un-normalized outline, reproduces the exact placed polygon", () => {
    // Drawn far from the origin — the point of this test is that a part's
    // own original-drawing position must not leak into where it lands.
    const original = [
      { x: 500, y: 700 },
      { x: 540, y: 700 },
      { x: 540, y: 730 },
      { x: 500, y: 730 },
    ];
    const parts: TrueNestPart[] = [
      { id: "p", name: "p", outer: original, holes: [], quantity: 1, rotation: { mode: "quarter" } },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 200, height: 200 }, qty: 1 }];
    const result = nestTrueShape(parts, stock);
    expect(result.placed).toHaveLength(1);
    const placement = result.placed[0];

    // What trueNest.ts itself placed (its internal local-frame + translation).
    const expectedPlaced = translate(
      localFrame(original, placement.rotationDeg, placement.mirrored),
      placement.translation.x,
      placement.translation.y,
    );

    // The same result, reconstructed via placementTransform applied to the
    // ORIGINAL (un-normalized) outline — the path materializeInstance takes.
    const transform = placementTransform(original, placement);
    const mirroredOriginal = transform.mirrored ? original.map((p) => ({ x: -p.x, y: p.y })) : original;
    const reconstructed = translate(rotate(mirroredOriginal, transform.rotationDeg), transform.translation.x, transform.translation.y);

    for (let i = 0; i < expectedPlaced.length; i++) {
      expect(reconstructed[i].x).toBeCloseTo(expectedPlaced[i].x, 6);
      expect(reconstructed[i].y).toBeCloseTo(expectedPlaced[i].y, 6);
    }
    // And it's actually on the sheet, not still off at (500, 700).
    const box = bounds(reconstructed);
    expect(box.minX).toBeGreaterThanOrEqual(-1e-6);
    expect(box.minY).toBeGreaterThanOrEqual(-1e-6);
  });
});

describe("nestTrueShape — N-12 part-in-hole", () => {
  // A 90x90 part leaves only a 10mm-wide rim on a 100x100 sheet — too
  // narrow for a 20x20 square in any orientation, so the small part below
  // can only ever be placed successfully by actually landing in the hole.
  const bigOuter = rect(90, 90);
  const hole = [
    { x: 30, y: 30 },
    { x: 60, y: 30 },
    { x: 60, y: 60 },
    { x: 30, y: 60 },
  ]; // 30x30, area 900

  function scenario(smallAllowInHoles: boolean): { parts: TrueNestPart[]; stock: StockRow[] } {
    return {
      parts: [
        { id: "big", name: "big", outer: bigOuter, holes: [hole], quantity: 1, rotation: { mode: "locked" } },
        { id: "small", name: "small", outer: rect(20, 20), holes: [], quantity: 1, rotation: { mode: "locked" }, allowInHoles: smallAllowInHoles },
      ],
      stock: [{ size: { name: "sheet", width: 100, height: 100 }, qty: 1 }] as StockRow[],
    };
  }

  it("places an allowInHoles part inside another part's hole instead of reporting it unplaced", () => {
    const { parts, stock } = scenario(true);
    const result = nestTrueShape(parts, stock);

    expect(result.unplaced).toEqual([]);
    expect(result.placed).toHaveLength(2);
    expect(result.sheets).toHaveLength(1); // proof it didn't fall back to a second sheet

    const small = result.placed.find((p) => p.partId === "small")!;
    expect(small).toBeDefined();
    expect(small.sheet).toBe(0);
    expect(small.translation.x).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(small.translation.x + 20).toBeLessThanOrEqual(60 + 1e-6);
    expect(small.translation.y).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(small.translation.y + 20).toBeLessThanOrEqual(60 + 1e-6);
  });

  it("N-40: tags a hole-filling placement with the index of the part whose hole it's in", () => {
    const { parts, stock } = scenario(true);
    const result = nestTrueShape(parts, stock);

    const bigIndex = result.placed.findIndex((p) => p.partId === "big");
    const small = result.placed.find((p) => p.partId === "small")!;
    expect(result.placed[bigIndex].insideOfPlacementIndex).toBeUndefined();
    expect(small.insideOfPlacementIndex).toBe(bigIndex);
  });

  it("never places a part inside a hole unless allowInHoles is set", () => {
    const { parts, stock } = scenario(false);
    const result = nestTrueShape(parts, stock);
    const smallUnplaced = result.unplaced.find((u) => u.partId === "small")?.count ?? 0;
    expect(smallUnplaced).toBe(1);
  });

  it("minHoleArea excludes a hole below the threshold from being offered", () => {
    const { parts, stock } = scenario(true);
    const result = nestTrueShape(parts, stock, { minHoleArea: 1000 }); // hole area is 900
    const smallUnplaced = result.unplaced.find((u) => u.partId === "small")?.count ?? 0;
    expect(smallUnplaced).toBe(1);
  });

  it("places several allowInHoles instances sharing one hole without overlapping each other", () => {
    const bigger = [
      { x: 20, y: 20 },
      { x: 70, y: 20 },
      { x: 70, y: 70 },
      { x: 20, y: 70 },
    ]; // 50x50 hole
    const parts: TrueNestPart[] = [
      { id: "big", name: "big", outer: bigOuter, holes: [bigger], quantity: 1, rotation: { mode: "locked" } },
      { id: "small", name: "small", outer: rect(20, 20), holes: [], quantity: 4, rotation: { mode: "locked" }, allowInHoles: true },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 1 }];
    const result = nestTrueShape(parts, stock, { spacing: 1 });

    const smalls = result.placed.filter((p) => p.partId === "small");
    expect(smalls).toHaveLength(4); // all 4 fit: a 2x2 grid of 20x20 + 1mm spacing comfortably fits a 50x50 hole
    for (let i = 0; i < smalls.length; i++) {
      for (let j = i + 1; j < smalls.length; j++) {
        const a = translate(rect(20, 20), smalls[i].translation.x, smalls[i].translation.y);
        const b = translate(rect(20, 20), smalls[j].translation.x, smalls[j].translation.y);
        expect(polygonsClash(a, b, 0)).toBe(false);
      }
    }
  });

  it("a hole-filling part's corners stay within the hole, never spilling into the surrounding part's solid material", () => {
    const { parts, stock } = scenario(true);
    const result = nestTrueShape(parts, stock);
    const small = result.placed.find((p) => p.partId === "small")!;
    const smallPolygon = translate(rect(20, 20), small.translation.x, small.translation.y);
    for (const p of smallPolygon) {
      expect(p.x).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(60 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(60 + 1e-6);
    }
  });
});
