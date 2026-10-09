import { describe, expect, it } from "vitest";
import { CommandBus, SketchDocument, blockFromEntities, makeInsert, type CircleEntity, type PolylineEntity } from "@sketchor/core";
import { extractParts } from "./partExtraction";

/**
 * B-10: a block instance is one nestable part. If extraction saw only the
 * instance's loose geometry, the nester would delete or copy the insert once
 * per loop (outer + every hole) and the plate would appear several times.
 */
const plate: PolylineEntity = { id: "o", type: "polyline", closed: true, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }] };
const hole: CircleEntity = { id: "h", type: "circle", center: { x: 10, y: 5 }, radius: 2 };

describe("block instances as nest parts", () => {
  it("a selected insert yields one part with the insert as its only source, holes included", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "put-table-record", table: "blocks", record: blockFromEntities("PLATE", [plate, hole]) });
    bus.execute({ type: "add-entity", entity: makeInsert("i1", "PLATE", { x: 100, y: 50 }, { rotation: Math.PI / 2 }) });
    const parts = extractParts(doc.all(), new Set(["i1"]));
    expect(parts).toHaveLength(1);
    expect(parts[0].sourceIds).toEqual(["i1"]);
    expect(parts[0].outerSourceIds).toEqual(["i1"]);
    expect(parts[0].holes).toHaveLength(1);
    expect(parts[0].holeSourceIds.flat()).toEqual([]);
    // Rotated 90 degrees about the insertion point: the 20 x 10 plate now spans 10 wide, 20 tall.
    const xs = parts[0].outer.map((p) => p.x);
    const ys = parts[0].outer.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 6);
  });
});
