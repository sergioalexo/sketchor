import { describe, expect, it } from "vitest";
import { nestTrueShapeSearch, LEVEL_BUDGET_MS } from "./search";
import { nestTrueShape, type TrueNestPart } from "./trueNest";
import type { StockRow } from "./stock";
import type { Point } from "./types";

/**
 * The search wrapper's whole job is to spend a time budget trying alternate
 * orderings and keep the best — getting "best" wrong (settling for fewer
 * placed parts, or picking one that placed everything but on more sheets
 * than another attempt) defeats the entire feature, and a cancel that
 * doesn't actually stop the loop leaves a panel waiting forever. A fake
 * clock and an instant `yield` make this deterministic without any real
 * waiting.
 */

function rect(w: number, h: number): Point[] {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
}

function fakeClock(stepMs = 100) {
  let t = 0;
  return { now: () => t, yield: () => { t += stepMs; return Promise.resolve(); } };
}

const parts: TrueNestPart[] = [
  { id: "big", name: "big", outer: rect(50, 50), holes: [], quantity: 3, rotation: { mode: "locked" } },
  { id: "small", name: "small", outer: rect(10, 10), holes: [], quantity: 5, rotation: { mode: "locked" } },
];
const stock: StockRow[] = [{ size: { name: "sheet", width: 120, height: 120 }, qty: 3 }];

describe("nestTrueShapeSearch", () => {
  it("quick is exactly one pass — identical to calling nestTrueShape directly", async () => {
    const direct = nestTrueShape(parts, stock);
    const { result, attempts, cancelled } = await nestTrueShapeSearch(parts, stock, { level: "quick" });
    expect(attempts).toBe(1);
    expect(cancelled).toBe(false);
    expect(result).toEqual(direct);
  });

  it("normal and thorough try more than one ordering within their budget", async () => {
    const clock = fakeClock();
    const { attempts } = await nestTrueShapeSearch(parts, stock, { level: "normal", budgetMs: 250, ...clock });
    expect(attempts).toBeGreaterThan(1);
  });

  it("a zero budget behaves like quick even at 'thorough' — no time to try anything else", async () => {
    const clock = fakeClock();
    const { attempts } = await nestTrueShapeSearch(parts, stock, { level: "thorough", budgetMs: 0, ...clock });
    expect(attempts).toBe(1);
  });

  it("keeps the attempt with fewer unplaced parts over one with merely higher utilisation", async () => {
    // A quantity chosen to sometimes leave one small part unplaced depending
    // on ordering (area-desc may waste a corner area-asc would have used) —
    // across several attempts, the search must never end up worse than its
    // own first (quick) pass.
    const tight: TrueNestPart[] = [
      { id: "big", name: "big", outer: rect(60, 60), holes: [], quantity: 2, rotation: { mode: "locked" } },
      { id: "small", name: "small", outer: rect(28, 28), holes: [], quantity: 4, rotation: { mode: "locked" } },
    ];
    const tightStock: StockRow[] = [{ size: { name: "sheet", width: 120, height: 120 }, qty: 1 }];
    const clock = fakeClock();
    const quick = await nestTrueShapeSearch(tight, tightStock, { level: "quick" });
    const thorough = await nestTrueShapeSearch(tight, tightStock, { level: "thorough", budgetMs: 2000, ...clock });
    const unplaced = (r: typeof quick.result) => r.unplaced.reduce((n, u) => n + u.count, 0);
    expect(unplaced(thorough.result)).toBeLessThanOrEqual(unplaced(quick.result));
    if (unplaced(thorough.result) === unplaced(quick.result)) {
      expect(thorough.result.utilisation).toBeGreaterThanOrEqual(quick.result.utilisation);
    }
  });

  it("reports increasing attempt numbers and the running best through onProgress", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    await nestTrueShapeSearch(parts, stock, {
      level: "normal",
      budgetMs: 250,
      ...clock,
      onProgress: (p) => seen.push(p.attempt),
    });
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[0]).toBe(1);
    expect(seen.length).toBeGreaterThan(1);
  });

  it("stops after the current attempt once isCancelled returns true, and reports cancelled", async () => {
    const clock = fakeClock();
    let calls = 0;
    const { attempts, cancelled } = await nestTrueShapeSearch(parts, stock, {
      level: "thorough",
      budgetMs: LEVEL_BUDGET_MS.thorough, // would otherwise run for a long (fake) time
      ...clock,
      isCancelled: () => ++calls > 2,
    });
    expect(cancelled).toBe(true);
    expect(attempts).toBeLessThan(10); // stopped early, not exhausted the budget
  });
});
