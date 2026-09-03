import { describe, expect, it } from "vitest";
import { nestByOrders } from "./nest";
import type { NestResult, Order, Pallet, TrailerProfile } from "./types";

const trailer: TrailerProfile = { name: "Test 13.6m", length: 13600, width: 2480 };

let seq = 0;
function pallet(over: Partial<Pallet> = {}): Pallet {
  seq += 1;
  return { id: `p${seq}`, width: 1200, length: 800, shape: "rect", ...over };
}
function order(city: string, pallets: Pallet[], color = "#000"): Order {
  seq += 1;
  return { id: `o${seq}`, city, color, pallets };
}

describe("nestByOrders", () => {
  it("places one entry per pallet row", () => {
    const r = nestByOrders(trailer, [order("A", [pallet(), pallet(), pallet()])]);
    expect(r.placed).toHaveLength(3);
    expect(r.unplaced).toHaveLength(0);
  });

  it("bands orders in unload sequence — first order at the door, later orders deeper", () => {
    const r = nestByOrders(trailer, [
      order("First", [pallet(), pallet()]),
      order("Second", [pallet(), pallet()]),
      order("Third", [pallet(), pallet()]),
    ]);
    const doorEdge = (idx: number) => Math.min(...r.placed.filter((p) => p.orderIndex === idx).map((p) => p.x));
    expect(doorEdge(0)).toBeCloseTo(0);
    expect(doorEdge(0)).toBeLessThanOrEqual(doorEdge(1));
    expect(doorEdge(1)).toBeLessThanOrEqual(doorEdge(2));
  });

  it("reordering the orders moves the bands", () => {
    const a = order("A", [pallet(), pallet(), pallet(), pallet()]);
    const b = order("B", [pallet()]);
    const first = nestByOrders(trailer, [a, b]);
    const swapped = nestByOrders(trailer, [b, a]);
    const bDoor = (r: typeof first) => Math.min(...r.placed.filter((p) => p.city === "B").map((p) => p.x));
    // B is deep when it's second, at the door when it's first.
    expect(bDoor(first)).toBeGreaterThan(bDoor(swapped));
    expect(bDoor(swapped)).toBeCloseTo(0);
  });

  it("places a round pallet and keeps it within the trailer width", () => {
    const r = nestByOrders(trailer, [order("A", [pallet({ shape: "round", width: 1000, length: 1000 })])]);
    expect(r.placed).toHaveLength(1);
    expect(r.placed[0].shape).toBe("round");
    expect(r.placed[0].y + r.placed[0].width).toBeLessThanOrEqual(trailer.width + 1e-6);
  });

  it("turns a rectangle 90° to fit a narrow trailer", () => {
    const narrow: TrailerProfile = { name: "narrow", length: 5000, width: 1300 };
    const r = nestByOrders(narrow, [order("A", [pallet({ width: 1400, length: 1000 })])]);
    expect(r.placed).toHaveLength(1);
    expect(r.placed[0].rotated).toBe(true);
    expect(r.placed[0].width).toBeLessThanOrEqual(narrow.width);
  });

  it("lets a later order fill the width an earlier one left free at the same depth", () => {
    // A: 3 pallets across a 2500-wide trailer; the 3rd opens a second row but
    // leaves the far half of that row empty. B's one pallet should drop into it,
    // sharing the length-slice rather than starting a fresh band behind A.
    const t: TrailerProfile = { name: "wide", length: 13600, width: 2500 };
    const a = order("A", [pallet(), pallet(), pallet()]);
    const b = order("B", [pallet()]);
    const r = nestByOrders(t, [a, b]);
    expect(r.unplaced).toHaveLength(0);
    const aFar = Math.max(...r.placed.filter((p) => p.city === "A").map((p) => p.x + p.length));
    const bNear = Math.min(...r.placed.filter((p) => p.city === "B").map((p) => p.x));
    // B starts before A's deepest edge — i.e. it's tucked alongside, not behind.
    expect(bNear).toBeLessThan(aFar);
  });

  it("never parks a later order in front of an earlier one over the same width", () => {
    const t: TrailerProfile = { name: "T", length: 13600, width: 2500 };
    const r = nestByOrders(t, [
      order("A", [pallet(), pallet(), pallet()]),
      order("B", [pallet(), pallet()]),
      order("C", [pallet()]),
    ]);
    for (const a of r.placed) {
      for (const b of r.placed) {
        const overlapY = a.y < b.y + b.width - 1e-6 && b.y < a.y + a.width - 1e-6;
        if (b.orderIndex > a.orderIndex && overlapY) {
          expect(b.x).toBeGreaterThanOrEqual(a.x - 1e-6);
        }
      }
    }
  });

  it("reports pallets too wide for the trailer as unplaced", () => {
    const r = nestByOrders(trailer, [order("A", [pallet({ width: 3000, length: 3000 })])]);
    expect(r.placed).toHaveLength(0);
    expect(r.unplaced[0]).toMatchObject({ city: "A", count: 1 });
  });

  it("keeps the overflow visible when the load is longer than the trailer", () => {
    const tiny: TrailerProfile = { name: "tiny", length: 1000, width: 2480 };
    const r = nestByOrders(tiny, [order("A", [pallet(), pallet(), pallet(), pallet(), pallet(), pallet()])]);
    expect(r.usedLength).toBeGreaterThan(tiny.length);
  });

  it("expands a pallet's qty into that many placed instances", () => {
    const r = nestByOrders(trailer, [order("A", [pallet({ qty: 5 })])]);
    expect(r.placed).toHaveLength(5);
    const r1 = nestByOrders(trailer, [order("A", [pallet({ qty: 5 }), pallet({ qty: 2 })])]);
    expect(r1.placed).toHaveLength(7);
  });

  it("carries a pallet tag through to the placed items", () => {
    const r = nestByOrders(trailer, [order("A", [pallet({ tag: "TOP" })])]);
    expect(r.placed[0].tag).toBe("TOP");
  });

  it("keeps pallets a wall clearance away from every edge", () => {
    const r = nestByOrders({ ...trailer, wallMargin: 150 }, [order("A", [pallet(), pallet()])]);
    for (const p of r.placed) {
      expect(p.x).toBeGreaterThanOrEqual(150 - 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(150 - 1e-6);
      expect(p.y + p.width).toBeLessThanOrEqual(trailer.width - 150 + 1e-6);
    }
  });

  it("a wall clearance shrinks the usable width", () => {
    // Two Ø1200 drums (no rotation) fit side by side across 2480, but not
    // across 2480 - 2*250 = 1980 — the second then has to sit deeper.
    const drums = [
      order("A", [pallet({ shape: "round", width: 1200, length: 1200 }), pallet({ shape: "round", width: 1200, length: 1200 })]),
    ];
    const depths = (r: NestResult) => new Set(r.placed.map((p) => Math.round(p.x))).size;
    expect(depths(nestByOrders(trailer, drums))).toBe(1);
    expect(depths(nestByOrders({ ...trailer, wallMargin: 250 }, drums))).toBe(2);
  });

  it("keeps a gap of twice the pallet margin between pallets of different orders", () => {
    const m = 40;
    const r = nestByOrders(trailer, [order("A", [pallet()]), order("B", [pallet()])], { palletMargin: m });
    const [a, b] = r.placed;
    const gapX = Math.max(a.x - (b.x + b.length), b.x - (a.x + a.length));
    const gapY = Math.max(a.y - (b.y + b.width), b.y - (a.y + a.width));
    // separated on at least one axis by >= 2*margin
    expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(2 * m - 1e-6);
  });
});
