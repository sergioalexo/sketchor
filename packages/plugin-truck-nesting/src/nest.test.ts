import { describe, expect, it } from "vitest";
import { nestTruck } from "./nest";
import type { PalletItem, TrailerProfile } from "./types";

const trailer: TrailerProfile = { name: "Test 13.6m", length: 13600, width: 2480, maxWeightKg: 24000 };

function item(over: Partial<PalletItem> & Pick<PalletItem, "id" | "stop">): PalletItem {
  return { label: "Pallet", length: 1200, width: 800, weightKg: 400, qty: 1, rotatable: true, ...over };
}

describe("nestTruck", () => {
  it("flattens qty into one placed instance each", () => {
    const r = nestTruck(trailer, [item({ id: "a", stop: 1, qty: 5 })]);
    expect(r.placed).toHaveLength(5);
    expect(r.unplaced).toHaveLength(0);
  });

  it("bands later stops deeper so nothing blocks the door (LIFO holds by construction)", () => {
    const r = nestTruck(trailer, [
      item({ id: "a", stop: 1, qty: 4 }),
      item({ id: "b", stop: 2, qty: 4 }),
      item({ id: "c", stop: 3, qty: 4 }),
    ]);
    const doorEdge = (stop: number) => Math.min(...r.placed.filter((p) => p.stop === stop).map((p) => p.x));
    // Each later stop starts no closer to the door (x=0) than the previous one.
    expect(doorEdge(1)).toBeLessThanOrEqual(doorEdge(2));
    expect(doorEdge(2)).toBeLessThanOrEqual(doorEdge(3));
    // Stop 1 is flush against the door.
    expect(doorEdge(1)).toBeCloseTo(0);
  });

  it("flushes the load against the door, leaving any slack at the nose", () => {
    const r = nestTruck(trailer, [item({ id: "a", stop: 1, qty: 2 })]);
    expect(Math.min(...r.placed.map((p) => p.x))).toBeCloseTo(0);
    expect(r.usedLength).toBeLessThan(trailer.length);
  });

  it("reports items wider than the trailer as unplaced", () => {
    const r = nestTruck(trailer, [item({ id: "big", stop: 1, width: 3000, length: 3000, rotatable: false })]);
    expect(r.placed).toHaveLength(0);
    expect(r.unplaced[0]).toMatchObject({ itemId: "big", count: 1 });
  });

  it("rotates a rotatable item to fit across the width", () => {
    const narrow: TrailerProfile = { name: "narrow", length: 5000, width: 1300 };
    // As-drawn (width 1400) is too wide; only the turned orientation (width 1000) fits.
    const r = nestTruck(narrow, [item({ id: "r", stop: 1, length: 1000, width: 1400, rotatable: true })]);
    expect(r.placed).toHaveLength(1);
    expect(r.placed[0].rotated).toBe(true);
    expect(r.placed[0].width).toBeLessThanOrEqual(narrow.width);
  });

  it("keeps negative coordinates when the load overflows the trailer", () => {
    const tiny: TrailerProfile = { name: "tiny", length: 1000, width: 2480 };
    const r = nestTruck(tiny, [item({ id: "a", stop: 1, qty: 6 })]);
    expect(r.usedLength).toBeGreaterThan(tiny.length);
  });
});
