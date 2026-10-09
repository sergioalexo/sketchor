/**
 * Why this matters: the in-place block editor draws the rest of the drawing
 * behind the definition. If the inverse placement is wrong (rotation, mirror,
 * base point) the context lands somewhere unrelated to what is being edited.
 */
import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { LineEntity } from "../entities";
import { applyAffine, insertMatrix } from "./evaluate";
import { blockFromEntities } from "./library";
import { makeInsert } from "./ops";
import { inPlaceBackdrop, invertAffine } from "./refedit";

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

describe("in-place block editing backdrop", () => {
  it("inverts affine maps and refuses singular ones", () => {
    const m = insertMatrix({ insert: { x: 5, y: -2 }, scale: { x: 2, y: -3 }, rotation: 0.7 }, { x: 1, y: 1 });
    const inv = invertAffine(m)!;
    const back = applyAffine(applyAffine(line("a", 3, 4, -1, 2), m), inv) as LineEntity;
    expect(back.a.x).toBeCloseTo(3, 9);
    expect(back.b.y).toBeCloseTo(2, 9);
    expect(invertAffine([0, 0, 0, 0, 1, 1])).toBeNull();
  });

  it("puts the neighbours where the instance sees them, drops the edited instance, keeps its twins", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "put-table-record", table: "blocks", record: blockFromEntities("B", [line("a", 0, 0, 10, 0)]) });
    bus.execute({ type: "add-entity", entity: makeInsert("edited", "B", { x: 100, y: 50 }, { rotation: Math.PI / 2 }) });
    bus.execute({ type: "add-entity", entity: makeInsert("twin", "B", { x: 300, y: 300 }) });
    // A wall 10 mm "above" the instance in its own frame: world (100, 60) is 10 along local y?
    // Instance rotated 90 deg: local +x is world +y, local +y is world -x.
    bus.execute({ type: "add-entity", entity: line("wall", 100, 60, 90, 60) });
    const back = inPlaceBackdrop(doc, "edited", "B")!;
    expect(back.some((e) => e.id === "edited" || e.id.startsWith("edited"))).toBe(false);
    const wall = back.find((e) => e.id === "wall") as LineEntity;
    expect(wall.a.x).toBeCloseTo(10, 9);
    expect(wall.a.y).toBeCloseTo(0, 9);
    expect(wall.b.x).toBeCloseTo(10, 9);
    expect(wall.b.y).toBeCloseTo(10, 9);
    // The twin is expanded to geometry (it is not an insert any more).
    expect(back.some((e) => e.type === "insert")).toBe(false);
    expect(back.filter((e) => e.type === "line")).toHaveLength(2);
  });

  it("returns null for a missing instance or the wrong block", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "put-table-record", table: "blocks", record: blockFromEntities("B", [line("a", 0, 0, 1, 0)]) });
    bus.execute({ type: "add-entity", entity: makeInsert("i", "B", { x: 0, y: 0 }) });
    expect(inPlaceBackdrop(doc, "nope", "B")).toBeNull();
    expect(inPlaceBackdrop(doc, "i", "OTHER")).toBeNull();
  });
});
