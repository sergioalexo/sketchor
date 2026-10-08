/**
 * Why this matters: an associative hatch that does not follow its boundary
 * leaves pattern floating in the wrong place after a move; one that is silently
 * deleted or re-flowed on undo corrupts the drawing. The follow must happen in
 * the same undo entry, a broken boundary must be flagged (not dropped), and a
 * direct edit of the hatch must drop the association.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { Entity, HatchEntity, PolylineEntity } from "../entities";
import "../kinds/builtin";
import { boundaryFromObjects } from "./boundary";
import { polygonArea, hatchPolygons } from "./loops";

const rect = (w: number, h: number): PolylineEntity => ({
  id: "r",
  type: "polyline",
  points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
  closed: true,
});

function setup(): { bus: CommandBus; doc: SketchDocument } {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  const r = rect(10, 10);
  bus.execute({ type: "add-entity", entity: r });
  const res = boundaryFromObjects([r])!;
  const h: HatchEntity = { id: "h", type: "hatch", loops: res.loops, paint: { kind: "solid", color: "#f00" }, style: "normal", associative: true, sources: ["r"] };
  bus.execute({ type: "add-entity", entity: h });
  return { bus, doc };
}

const area = (h: HatchEntity) => Math.abs(polygonArea(hatchPolygons(h, 0.01)[0]));

describe("hatch associativity", () => {
  it("follows an edit of its boundary in the same undo entry", () => {
    const { bus, doc } = setup();
    bus.execute({ type: "update-entity", entity: rect(20, 10) as Entity });
    expect(area(doc.get("h") as HatchEntity)).toBeCloseTo(200, 3);
    bus.undo();
    expect(area(doc.get("h") as HatchEntity)).toBeCloseTo(100, 3);
    expect((doc.get("r") as PolylineEntity).points[1].x).toBe(10);
    bus.redo();
    expect(area(doc.get("h") as HatchEntity)).toBeCloseTo(200, 3);
  });

  it("flags a lost boundary and keeps the loops; undo clears it", () => {
    const { bus, doc } = setup();
    const before = (doc.get("h") as HatchEntity).loops;
    bus.execute({ type: "update-entity", entity: { ...rect(10, 10), closed: false } as Entity });
    const h = doc.get("h") as HatchEntity;
    expect(h.boundaryLost).toBe(true);
    expect(h.loops).toEqual(before);
    bus.undo();
    expect((doc.get("h") as HatchEntity).boundaryLost).toBeUndefined();
  });

  it("flags a deleted source, and a direct edit drops associativity", () => {
    const a = setup();
    a.bus.execute({ type: "delete-entities", ids: ["r"] });
    expect((a.doc.get("h") as HatchEntity).boundaryLost).toBe(true);
    const b = setup();
    const h = b.doc.get("h") as HatchEntity;
    const loops = h.loops.map((l) => ({ ...l, edges: l.edges.map((e) => (e.type === "line" ? { ...e, a: { x: e.a.x + 1, y: e.a.y } } : e)) }));
    b.bus.execute({ type: "update-entity", entity: { ...h, loops } });
    expect((b.doc.get("h") as HatchEntity).associative).toBe(false);
  });

  it("does nothing for non-associative hatches", () => {
    const { bus, doc } = setup();
    const h = doc.get("h") as HatchEntity;
    bus.execute({ type: "update-entity", entity: { ...h, associative: false } });
    bus.execute({ type: "update-entity", entity: rect(20, 10) as Entity });
    expect(area(doc.get("h") as HatchEntity)).toBeCloseTo(100, 3);
  });
});
