/**
 * Why this matters: mirroring an array of block instances used to do nothing
 * (the transform refused), and a scale edit on a "scale uniformly" block must
 * not distort it. Mirrored geometry is compared point for point against the
 * mirrored original, so a wrong row direction cannot hide.
 */
import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { InsertEntity, LineEntity } from "../entities";
import { applyGrip, gripsOf } from "../grips";
import { mirrored } from "../mirror";
import { stretchEntity } from "../stretch";
import { blockFromEntities } from "./library";
import { makeInsert } from "./ops";
import { evaluateInsert } from "./evaluate";
import { isMirroredInsert, withInsertArray, withInsertScale } from "./insertEdit";

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

function setup() {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  bus.execute({ type: "put-table-record", table: "blocks", record: blockFromEntities("B", [line("a", 0, 0, 4, 1), line("b", 1, 2, 1, 3)]) });
  const ins = makeInsert("i", "B", { x: 3, y: 2 }, { rotation: 0.4, scale: { x: 1.5, y: 1.5 }, array: { cols: 3, rows: 2, colSpacing: 10, rowSpacing: 7 } });
  bus.execute({ type: "add-entity", entity: ins });
  return { doc, bus, ins };
}

const endpoints = (es: LineEntity[]) => es.flatMap((e) => [e.a, e.b]).map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort();

describe("B-10 block-aware editing", () => {
  it.each([
    [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    [{ x: 2, y: 1 }, { x: 5, y: 9 }],
    [{ x: -3, y: 4 }, { x: -3, y: 8 }],
  ])("mirroring an array insert reflects every cell (axis %j -> %j)", (a, b) => {
    const { doc, ins } = setup();
    const out = mirrored(ins, a, b);
    expect(out).not.toBe(ins);
    const want = endpoints(evaluateInsert(doc, ins).map((e) => mirrored(e, a, b)) as LineEntity[]);
    expect(endpoints(evaluateInsert(doc, out) as LineEntity[])).toEqual(want);
    expect(isMirroredInsert(out)).toBe(true);
  });

  it("mirroring twice returns the original placement", () => {
    const { ins } = setup();
    const axis = [{ x: 0, y: 0 }, { x: 1, y: 2 }] as const;
    const back = mirrored(mirrored(ins, axis[0], axis[1]), axis[0], axis[1]);
    expect(back.insert.x).toBeCloseTo(ins.insert.x, 9);
    expect(back.rotation).toBeCloseTo(ins.rotation, 9);
    expect(back.array?.rowSpacing).toBeCloseTo(7, 9);
    expect(back.scale.y).toBeCloseTo(1.5, 9);
  });

  it("scale edits honour uniform blocks and the lock, ignore zero", () => {
    const { ins } = setup();
    expect(withInsertScale(ins, undefined, "x", 3).scale).toEqual({ x: 3, y: 1.5 });
    expect(withInsertScale(ins, undefined, "x", 3, true).scale).toEqual({ x: 3, y: 3 });
    expect(withInsertScale({ ...ins, scale: { x: 2, y: -1 } }, undefined, "x", 4, true).scale).toEqual({ x: 4, y: -2 });
    const uniform = { name: "B", scaleUniformly: true } as never;
    expect(withInsertScale(ins, uniform, "y", 3).scale).toEqual({ x: 3, y: 3 });
    expect(withInsertScale(ins, undefined, "x", 0)).toBe(ins);
  });

  it("array edits clamp counts and drop a 1x1 array", () => {
    const { ins } = setup();
    expect(withInsertArray(ins, { cols: 0.2 }).array?.cols).toBe(1);
    expect(withInsertArray(withInsertArray(ins, { cols: 1 }), { rows: 1 }).array).toBeUndefined();
    expect(withInsertArray({ ...ins, array: undefined }, { cols: 2, colSpacing: 5 }).array).toEqual({ cols: 2, rows: 1, colSpacing: 5, rowSpacing: 0 });
  });

  it("stretch moves an instance whole only when its insertion point is in the box", () => {
    const { ins } = setup();
    const around = { minX: 2, minY: 1, maxX: 4, maxY: 3 };
    const moved = stretchEntity(ins, around, 5, 0) as InsertEntity;
    expect(moved.insert).toEqual({ x: 8, y: 2 });
    expect(stretchEntity(ins, { minX: 20, minY: 20, maxX: 30, maxY: 30 }, 5, 0)).toBeNull();
  });

  it("rotation grip sits on the instance's x axis and dragging it sets the rotation", () => {
    const { ins } = setup();
    const g = gripsOf(ins).find((x) => x.kind === "rotate")!;
    expect(Math.atan2(g.point.y - ins.insert.y, g.point.x - ins.insert.x)).toBeCloseTo(ins.rotation, 9);
    const turned = applyGrip(ins, g, { x: ins.insert.x, y: ins.insert.y + 5 }) as InsertEntity;
    expect(turned.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(applyGrip(ins, g, ins.insert)).toBe(ins);
  });
});
