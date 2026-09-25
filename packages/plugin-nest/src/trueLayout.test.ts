import { describe, expect, it } from "vitest";
import type { Command, DocumentReadModel } from "@sketchor/plugin-sdk";
import type { Entity } from "@sketchor/core";
import { buildTrueNestLayout, checkNestOverlaps, type SheetPlacementEntities } from "./trueLayout";
import { NEST_LAYER } from "./layout";
import type { TrueNestSheet } from "./trueNest";

function poly(id: string, points: { x: number; y: number }[], closed = true): Entity {
  return { id, type: "polyline", points, closed, layer: NEST_LAYER };
}

describe("buildTrueNestLayout", () => {
  it("draws a titled outline per sheet, offsets sheets by each one's own height, and groups per sheet", () => {
    const sheets: TrueNestSheet[] = [
      { stockIndex: 0, width: 100, height: 50 },
      { stockIndex: 0, width: 200, height: 80 },
    ];
    const placements: SheetPlacementEntities[] = [
      { sheet: 0, entities: [poly("part-a", [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])] },
      { sheet: 1, entities: [poly("part-b", [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }])] },
    ];
    const commands = buildTrueNestLayout(sheets, placements, (sheet, i) => `Sheet ${i + 1}/2 – ${sheet.width}x${sheet.height}`);

    const adds = commands.filter((c): c is Extract<Command, { type: "add-entity" }> => c.type === "add-entity");
    const groups = commands.filter((c): c is Extract<Command, { type: "group-entities" }> => c.type === "group-entities");

    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe("Sheet 1/2 – 100x50");
    expect(groups[1].name).toBe("Sheet 2/2 – 200x80");

    // Sheet 2 is stacked below sheet 1: offset = 50 (sheet 1's height) + 200 (SHEET_GAP).
    const sheet2Outline = adds.find((c) => c.entity.type === "polyline" && c.entity.name === "Sheet 2/2 – 200x80");
    expect(sheet2Outline?.entity.type).toBe("polyline");
    if (sheet2Outline?.entity.type === "polyline") {
      const ys = sheet2Outline.entity.points.map((p) => p.y);
      expect(Math.min(...ys)).toBeCloseTo(250, 6); // 50 + 200
    }

    // The placed part on sheet 2 is shifted by the same offset.
    const placedOnSheet2 = adds.find((c) => c.entity.id === "part-b");
    expect(placedOnSheet2?.entity.type).toBe("polyline");
    if (placedOnSheet2?.entity.type === "polyline") {
      expect(placedOnSheet2.entity.points[0].y).toBeCloseTo(250, 6);
    }

    // Every added entity lands on the Nest layer.
    for (const c of adds) expect(c.entity.layer).toBe(NEST_LAYER);
  });

  it("produces no groups for an empty result", () => {
    expect(buildTrueNestLayout([], [], () => "")).toEqual([]);
  });
});

describe("checkNestOverlaps", () => {
  function model(entities: Entity[], groups: DocumentReadModel["groups"]): DocumentReadModel {
    return { revision: 1, entities, groups, constraints: [] };
  }

  it("reports no issue for a clean, non-overlapping sheet", () => {
    const outline = poly("outline", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
    const a = poly("a", [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }]);
    const b = poly("b", [{ x: 30, y: 30 }, { x: 40, y: 30 }, { x: 40, y: 40 }, { x: 30, y: 40 }]);
    const groups = [{ id: "g1", members: ["outline", "a", "b"], name: "Sheet 1" }];
    expect(checkNestOverlaps(model([outline, a, b], groups))).toEqual([]);
  });

  it("flags a sheet where two placed parts overlap after a drag", () => {
    const outline = poly("outline", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
    const a = poly("a", [{ x: 10, y: 10 }, { x: 25, y: 10 }, { x: 25, y: 25 }, { x: 10, y: 25 }]);
    const b = poly("b", [{ x: 20, y: 20 }, { x: 35, y: 20 }, { x: 35, y: 35 }, { x: 20, y: 35 }]); // overlaps a
    const groups = [{ id: "g1", members: ["outline", "a", "b"], name: "Sheet 1" }];
    const issues = checkNestOverlaps(model([outline, a, b], groups));
    expect(issues).toEqual([{ groupName: "Sheet 1" }]);
  });

  it("ignores groups that aren't entirely on the Nest layer", () => {
    const other: Entity = { id: "x", type: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true };
    const groups = [{ id: "g1", members: ["x"], name: "Not a nest group" }];
    expect(checkNestOverlaps(model([other], groups))).toEqual([]);
  });
});
