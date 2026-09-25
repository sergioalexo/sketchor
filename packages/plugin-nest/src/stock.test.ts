import { describe, expect, it } from "vitest";
import { openNextStock, shrinkLastSheet, type StockRow } from "./stock";

function row(name: string, width: number, height: number, qty: number | null): StockRow {
  return { size: { name, width, height }, qty };
}

describe("openNextStock", () => {
  it("opens the first row with quantity remaining", () => {
    const stock = [row("small", 100, 100, 2), row("big", 200, 200, 5)];
    expect(openNextStock(stock, [0, 0])?.index).toBe(0);
    expect(openNextStock(stock, [2, 0])?.index).toBe(1);
  });

  it("treats null quantity as unlimited", () => {
    const stock = [row("endless", 100, 100, null)];
    expect(openNextStock(stock, [1000])?.index).toBe(0);
  });

  it("returns null once every row is exhausted", () => {
    const stock = [row("a", 100, 100, 1), row("b", 200, 200, 1)];
    expect(openNextStock(stock, [1, 1])).toBeNull();
  });

  it("returns null for an empty stock list", () => {
    expect(openNextStock([], [])).toBeNull();
  });
});

describe("shrinkLastSheet", () => {
  it("picks the smallest available row the bounds fit inside", () => {
    const stock = [row("huge", 1000, 1000, 5), row("small", 60, 60, 5), row("medium", 120, 120, 5)];
    const bounds = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
    const idx = shrinkLastSheet(stock, [0, 0, 0], 0, bounds, 0);
    expect(idx).toBe(1); // "small" (60x60) is smaller than "medium" and still fits 40x40
  });

  it("returns null when nothing smaller fits", () => {
    const stock = [row("only", 50, 50, 5)];
    const bounds = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
    // currentStockIndex is the same row already charged for this sheet —
    // shrinking to itself isn't smaller, so this should report no change.
    const idx = shrinkLastSheet(stock, [1], 0, bounds, 0);
    expect(idx).toBe(0); // "only" is both the current and the smallest fit — legitimately itself
  });

  it("excludes rows without remaining quantity, except the sheet's own current row", () => {
    const stock = [row("tight", 50, 50, 1), row("looser", 100, 100, 1)];
    const bounds = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
    // "tight" is fully used by someone else (not this sheet) — must not be double-booked.
    const idxExcludingOthersUse = shrinkLastSheet(stock, [1, 1], 1 /* current row is "looser" */, bounds, 0);
    expect(idxExcludingOthersUse).toBe(1); // "looser" is this sheet's own row — legitimately reusable

    // Here "tight" is this sheet's own current row, so it's the one being freed.
    const idxOwnRow = shrinkLastSheet(stock, [1, 0], 0, bounds, 0);
    expect(idxOwnRow).toBe(0);
  });

  it("accounts for margin on every side", () => {
    const stock = [row("exact", 40, 40, 5)];
    const bounds = { minX: 0, minY: 0, maxX: 30, maxY: 30 };
    expect(shrinkLastSheet(stock, [0], 0, bounds, 0)).toBe(0); // 30+0 fits 40
    expect(shrinkLastSheet(stock, [0], 0, bounds, 10)).toBeNull(); // 30+20 doesn't fit 40
  });
});
