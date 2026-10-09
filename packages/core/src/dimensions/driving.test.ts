/**
 * D-02b core: a driving dimension is the solver constraint, so editing its
 * value must move the geometry in the same undo step, and a dimension that
 * cannot be expressed must drive nothing rather than fight the solver.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { DimensionEntity, LineEntity } from "../entities";
import "../kinds/builtin";

const dim = (over: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: "d1",
  type: "dimension",
  kind: "linear",
  defPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 20 }],
  driving: false,
  ...over,
});

describe("driving dimensions", () => {
  it("a horizontal dimension and a radius dimension move the geometry; undo restores it", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: { id: "l1", type: "line", a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } });
    bus.execute({ type: "add-entity", entity: { id: "c1", type: "circle", center: { x: 0, y: 50 }, radius: 10 } });
    bus.execute({ type: "add-constraint", constraint: { id: "fx", type: "fix", entityId: "l1" } });
    // Freeing the far end again would defeat the test: fix only the near end through a point.
    bus.execute({ type: "remove-constraint", id: "fx" });
    bus.execute({ type: "add-entity", entity: { id: "k0", type: "point", p: { x: 0, y: 0 } } });
    bus.execute({ type: "add-constraint", constraint: { id: "fp", type: "fix", entityId: "k0" } });
    bus.execute({ type: "add-constraint", constraint: { id: "co", type: "coincident", a: { entityId: "l1", point: "a" }, b: { entityId: "k0", point: "a" } } });
    const refs = [{ entityId: "l1", point: "a" as const }, { entityId: "l1", point: "b" as const }, null];
    bus.execute({ type: "add-entity", entity: dim({ refs, driving: true, value: 100 }) });
    bus.execute({ type: "add-entity", entity: dim({ id: "d2", kind: "radial", target: "c1", defPoints: [{ x: 0, y: 50 }, { x: 10, y: 50 }], driving: true, value: 10 }) });
    bus.execute({ type: "update-entity", entity: { ...(doc.get("d1") as DimensionEntity), value: 140 } });
    expect((doc.get("l1") as LineEntity).b.x).toBeCloseTo(140, 3);
    bus.execute({ type: "update-entity", entity: { ...(doc.get("d2") as DimensionEntity), value: 25 } });
    expect((doc.get("c1") as { radius: number }).radius).toBeCloseTo(25, 3);
    bus.undo();
    expect((doc.get("c1") as { radius: number }).radius).toBeCloseTo(10, 3);
  });

  it("a reference dimension, or a driving one with nothing attached, drives nothing", () => {
    const doc = new SketchDocument();
    doc._put(dim({ driving: true, value: 100 }));
    doc._put(dim({ id: "d2", driving: false, value: 5 }));
    expect(doc.solverConstraints()).toEqual([]);
  });

  it("derives distance (with axis), radius and angle constraints", () => {
    const doc = new SketchDocument();
    doc._put({ id: "l1", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    doc._put({ id: "l2", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 10 } });
    doc._put({ id: "c1", type: "circle", center: { x: 0, y: 0 }, radius: 4 });
    const refs = [{ entityId: "l1", point: "a" as const }, { entityId: "l1", point: "b" as const }, null];
    doc._put(dim({ refs, driving: true, value: 10 }));
    doc._put(dim({ id: "dd", kind: "diametric", target: "c1", defPoints: [{ x: 0, y: 0 }, { x: 4, y: 0 }], driving: true, value: 8 }));
    doc._put(dim({ id: "da", kind: "angular2l", targets: ["l1", "l2"], defPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 8, y: 3 }], driving: true, value: Math.PI / 4 }));
    const cs = doc.solverConstraints();
    expect(cs.find((c) => c.id === "dim:d1")).toMatchObject({ type: "distance", axis: "x", value: 10 });
    expect(cs.find((c) => c.id === "dim:dd")).toMatchObject({ type: "radius", value: 4 });
    const ang = cs.find((c) => c.id === "dim:da");
    expect(ang).toMatchObject({ type: "angle" });
    expect((ang as { value: number }).value).toBeCloseTo(Math.PI / 4);
  });
});
