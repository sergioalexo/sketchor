import { describe, expect, it } from "vitest";
import { polygonsClash } from "./geometry";
import { nestParts } from "./nest";
import type { NestPart, Point, Sheet } from "./types";

const square = (s: number): Point[] => [
  { x: 0, y: 0 },
  { x: s, y: 0 },
  { x: s, y: s },
  { x: 0, y: s },
];
const rect = (w: number, h: number): Point[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

const sheet = (w: number, h: number): Sheet => ({ name: "S", width: w, height: h });
function part(id: string, polygon: Point[], quantity: number, round = false): NestPart {
  return { id, polygon, quantity, round };
}

describe("nestParts", () => {
  it("packs four squares onto one sheet without overlap", () => {
    const r = nestParts([part("a", square(40), 4)], sheet(100, 100));
    expect(r.placed).toHaveLength(4);
    expect(r.unplaced).toHaveLength(0);
    expect(r.sheetsUsed).toBe(1);
    for (let i = 0; i < r.placed.length; i++) {
      for (let j = i + 1; j < r.placed.length; j++) {
        expect(polygonsClash(r.placed[i].polygon, r.placed[j].polygon)).toBe(false);
      }
    }
  });

  it("keeps every part off the sheet edge by the spacing", () => {
    const r = nestParts([part("a", square(20), 3)], sheet(200, 60), { spacing: 6 });
    for (const p of r.placed) {
      for (const q of p.polygon) {
        expect(q.x).toBeGreaterThanOrEqual(6 - 1e-6);
        expect(q.y).toBeGreaterThanOrEqual(6 - 1e-6);
        expect(q.x).toBeLessThanOrEqual(200 - 6 + 1e-6);
      }
    }
  });

  it("reports a part too big for the sheet as unplaced", () => {
    const r = nestParts([part("big", square(300), 1)], sheet(100, 100));
    expect(r.placed).toHaveLength(0);
    expect(r.unplaced).toEqual([{ partId: "big", count: 1 }]);
  });

  it("rotation lets a tall part fit a short wide sheet", () => {
    const tall = part("t", rect(20, 90), 1);
    expect(nestParts([tall], sheet(200, 30)).placed).toHaveLength(0);
    expect(nestParts([tall], sheet(200, 30), { rotation: "quarter" }).placed).toHaveLength(1);
    expect(nestParts([tall], sheet(200, 30), { rotation: "quarter" }).placed[0].rotationDeg % 180).toBe(90);
  });

  it("spills onto extra sheets up to maxSheets", () => {
    const many = part("a", square(60), 6); // ~1 per 100×100 sheet
    expect(nestParts([many], sheet(100, 100), { maxSheets: 1 }).unplaced[0].count).toBe(5);
    const three = nestParts([many], sheet(100, 100), { maxSheets: 3 });
    expect(three.sheetsUsed).toBe(3);
    expect(three.placed).toHaveLength(3);
  });

  it("reports utilisation between 0 and 1", () => {
    const r = nestParts([part("a", square(50), 2)], sheet(100, 100));
    expect(r.utilisation).toBeGreaterThan(0);
    expect(r.utilisation).toBeLessThanOrEqual(1);
  });
});
