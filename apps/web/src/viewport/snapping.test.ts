import { describe, expect, it } from "vitest";
import { SketchDocument, entityPoints, type Entity } from "@sketchor/core";
import { snapMovingSelection } from "./snapping";
import type { View } from "./view";

const view: View = { scale: 1, ox: 0, oy: 0 }; // 1 px = 1 world unit → snap tol = 10

function doc(...entities: Entity[]): SketchDocument {
  const d = new SketchDocument();
  for (const e of entities) d._put(e);
  return d;
}

function rect(id: string, x: number, y: number, w: number, h: number, extra: Partial<Entity> = {}): Entity {
  return {
    id,
    type: "polyline",
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    closed: true,
    ...extra,
  } as Entity;
}

const verts = (...es: Entity[]) => es.flatMap((e) => entityPoints(e));

describe("snapMovingSelection", () => {
  it("leaves the offset alone when nothing is in range", () => {
    const a = rect("a", 0, 0, 100, 100);
    const b = rect("b", 500, 0, 100, 100);
    const out = snapMovingSelection(doc(a, b), view, verts(b), -50, -30, ["b"]);
    expect(out).toEqual({ dx: -50, dy: -30 });
  });

  it("pulls a dragged rect so its corner lands exactly on a neighbour's", () => {
    const a = rect("a", 0, 0, 1000, 1000); // right edge at x = 1000
    const b = rect("b", 1500, 0, 1000, 1000); // left edge at x = 1500
    // drag left by 495 — b's left edge would reach x = 1005, 5 short of a's edge
    const { dx, dy } = snapMovingSelection(doc(a, b), view, verts(b), -495, 0, ["b"]);
    expect(dx).toBeCloseTo(-500); // snapped the last 5 so the corners coincide
    expect(dy).toBeCloseTo(0);
  });

  it("snaps on any selection vertex, not just the first", () => {
    const a = rect("a", 0, 0, 1000, 1000);
    const b = rect("b", 1500, 0, 1000, 1000);
    // b's far corner (2500,1000) is nowhere near a; its near corner (1500,0) is
    // what should catch — order in the vertex list must not matter
    const shuffled = [...verts(b)].reverse();
    const { dx } = snapMovingSelection(doc(a, b), view, shuffled, -496, 0, ["b"]);
    expect(dx).toBeCloseTo(-500);
  });

  it("aligns a pallet's margin guide to a neighbour's guide", () => {
    // pallet A: shape 0..1000, dashed guide -30..1030
    const aShape = rect("as", 0, 0, 1000, 1000, { fill: "#e00" });
    const aGuide = rect("ag", -30, -30, 1060, 1060, { dashed: true });
    // pallet B: shape 1700..2700, guide 1670..2730
    const bShape = rect("bs", 1700, 0, 1000, 1000, { fill: "#00e" });
    const bGuide = rect("bg", 1670, -30, 1060, 1060, { dashed: true });
    const d = doc(aShape, aGuide, bShape, bGuide);
    // Drag B left by 697: B's guide left edge 1670 → 973, 3 past A's guide right
    // edge (1030)? no — 973 vs 1030 is 57 away. Aim so the guides meet: move
    // 1670 → 1030 needs -640; try -635 (5 short) and expect the guide corners to click.
    const { dx } = snapMovingSelection(d, view, verts(bShape, bGuide), -635, 0, ["bs", "bg"]);
    expect(dx).toBeCloseTo(-640); // B guide's (1670,-30) snapped onto A guide's (1030,-30)
  });

  it("does not snap the selection to its own geometry", () => {
    const b = rect("b", 1500, 0, 1000, 1000);
    // only entity present is the one being moved — must be a free move
    const out = snapMovingSelection(doc(b), view, verts(b), -12, -8, ["b"]);
    expect(out).toEqual({ dx: -12, dy: -8 });
  });
});
