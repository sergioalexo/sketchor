/**
 * Why this matters: trimming a hatch must remove exactly the piece the user
 * clicked and leave the rest painted with the same pattern phase; a wrong
 * piece or a lost island silently changes what is cut or printed.
 */
import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import type { Entity, HatchEntity, LineEntity } from "../entities";
import "./library";
import { hatchContains, loopFromCircle, loopFromPoints } from "./loops";
import { interiorPoints, trimHatch } from "./trim";

const square = loopFromPoints([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }]);
const hatch = (over: Partial<HatchEntity> = {}): HatchEntity => ({
  id: "h",
  type: "hatch",
  name: "H1",
  layer: "walls",
  loops: [square],
  paint: { kind: "pattern", name: "ANSI31", scale: 2, angle: 10, origin: { x: 3, y: 4 } },
  style: "normal",
  associative: true,
  sources: ["a", "b"],
  ...over,
});
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

describe("trim hatch", () => {
  it("a cutter across the hatch splits it; the clicked piece goes, the other keeps its pattern and loses associativity", () => {
    const cut: Entity = line("c", 10, -5, 10, 25);
    const out = trimHatch(hatch(), [cut], { x: 4, y: 10 })!;
    expect(out).toHaveLength(1);
    const kept = out[0];
    expect(hatchContains(kept, { x: 15, y: 10 })).toBe(true);
    expect(hatchContains(kept, { x: 4, y: 10 })).toBe(false);
    expect(kept.paint).toEqual(hatch().paint);
    expect(kept.layer).toBe("walls");
    expect(kept.associative).toBeUndefined();
    expect(kept.sources).toBeUndefined();
    expect(kept.id).not.toBe("h");
  });

  it("two cutters leave two pieces", () => {
    const out = trimHatch(hatch(), [line("c1", 7, -5, 7, 25), line("c2", 14, -5, 14, 25)], { x: 10, y: 10 })!;
    expect(out).toHaveLength(2);
    const xs = out.map((h) => (hatchContains(h, { x: 3, y: 10 }) ? "left" : hatchContains(h, { x: 17, y: 10 }) ? "right" : "?")).sort();
    expect(xs).toEqual(["left", "right"]);
  });

  it("an island stays a hole in the piece that surrounds it", () => {
    const h = hatch({ loops: [square, { ...loopFromCircle({ x: 15, y: 10 }, 2) }] });
    const out = trimHatch(h, [line("c", 8, -5, 8, 25)], { x: 3, y: 10 })!;
    expect(out).toHaveLength(1);
    expect(hatchContains(out[0], { x: 12, y: 3 })).toBe(true);
    expect(hatchContains(out[0], { x: 15, y: 10 })).toBe(false);
  });

  it("returns null when nothing cuts, the click is outside, or a cutter only touches", () => {
    expect(trimHatch(hatch(), [], { x: 5, y: 5 })).toBeNull();
    expect(trimHatch(hatch(), [line("c", 10, -5, 10, 25)], { x: 50, y: 5 })).toBeNull();
    expect(trimHatch(hatch(), [line("c", 30, -5, 30, 25)], { x: 5, y: 5 })).toBeNull();
  });

  it("interiorPoints finds points inside a concave polygon", () => {
    const u = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 7, y: 10 }, { x: 7, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 10 }, { x: 0, y: 10 }];
    const pts = interiorPoints(u);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) expect(hatchContains(hatch({ loops: [loopFromPoints(u)] }), p)).toBe(true);
  });
});
