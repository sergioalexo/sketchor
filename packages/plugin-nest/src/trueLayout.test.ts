import { describe, expect, it } from "vitest";
import type { Command, DocumentReadModel } from "@sketchor/plugin-sdk";
import type { Entity } from "@sketchor/core";
import { buildTrueNestLayout, checkNestOverlaps, sheetOffsets, sheetOutlineEntities, type SheetPlacementEntities } from "./trueLayout";
import { NEST_HOLES_LAYER, NEST_LABELS_LAYER, NEST_PARTS_LAYER, NEST_SHEET_LAYER } from "./layout";
import type { TrueNestSheet } from "./trueNest";

function poly(id: string, points: { x: number; y: number }[], closed = true): Entity {
  return { id, type: "polyline", points, closed };
}

describe("buildTrueNestLayout", () => {
  it("draws a titled outline per sheet, offsets sheets by each one's own height, and groups per sheet", () => {
    const sheets: TrueNestSheet[] = [
      { stockIndex: 0, width: 100, height: 50 },
      { stockIndex: 0, width: 200, height: 80 },
    ];
    const placements: SheetPlacementEntities[] = [
      {
        sheet: 0,
        number: 1,
        outerEntities: [poly("part-a", [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])],
        holeEntities: [],
        label: { at: { x: 5, y: 5 }, height: 3 },
      },
      {
        sheet: 1,
        number: 2,
        outerEntities: [poly("part-b", [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }])],
        holeEntities: [poly("part-b-hole", [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }])],
        label: { at: { x: 2.5, y: 2.5 }, height: 1.5 },
      },
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
    expect(sheet2Outline?.entity.layer).toBe(NEST_SHEET_LAYER);

    // The placed part on sheet 2 is shifted by the same offset, on the Parts layer.
    const placedOnSheet2 = adds.find((c) => c.entity.id === "part-b");
    expect(placedOnSheet2?.entity.type).toBe("polyline");
    if (placedOnSheet2?.entity.type === "polyline") {
      expect(placedOnSheet2.entity.points[0].y).toBeCloseTo(250, 6);
    }
    expect(placedOnSheet2?.entity.layer).toBe(NEST_PARTS_LAYER);

    // Its hole is on its own layer, also shifted.
    const hole = adds.find((c) => c.entity.id === "part-b-hole");
    expect(hole?.entity.layer).toBe(NEST_HOLES_LAYER);
    if (hole?.entity.type === "polyline") {
      expect(hole.entity.points[0].y).toBeCloseTo(251, 6); // 1 (local) + 250 (offset)
    }

    // Every sheet gets a title and every placement gets a number label, on the Labels layer.
    const labels = adds.filter((c) => c.entity.layer === NEST_LABELS_LAYER);
    expect(labels.length).toBe(2 /* sheet titles */ + 2 /* part numbers */);
    const numberLabels = labels.filter((c) => c.entity.type === "text" && (c.entity.text === "1" || c.entity.text === "2"));
    expect(numberLabels).toHaveLength(2);
  });

  it("produces no groups for an empty result", () => {
    expect(buildTrueNestLayout([], [], () => "")).toEqual([]);
  });
});

describe("sheetOutlineEntities / sheetOffsets", () => {
  it("builds a sheet's outline and title in local (unshifted) coordinates, on the right layers", () => {
    const sheet: TrueNestSheet = { stockIndex: 0, width: 120, height: 60 };
    const { outline, title } = sheetOutlineEntities(sheet, "Sheet 1");
    expect(outline.layer).toBe(NEST_SHEET_LAYER);
    expect(title.layer).toBe(NEST_LABELS_LAYER);
    if (outline.type === "polyline") {
      const xs = outline.points.map((p) => p.x);
      const ys = outline.points.map((p) => p.y);
      expect(Math.min(...xs)).toBe(0);
      expect(Math.max(...xs)).toBe(120);
      expect(Math.min(...ys)).toBe(0);
      expect(Math.max(...ys)).toBe(60);
    }
  });

  it("stacks sheets downward by each one's own height plus the gap", () => {
    const sheets: TrueNestSheet[] = [
      { stockIndex: 0, width: 100, height: 50 },
      { stockIndex: 0, width: 100, height: 80 },
    ];
    const offsets = sheetOffsets(sheets);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(250); // 50 + 200 (SHEET_GAP)
  });
});

describe("checkNestOverlaps", () => {
  function model(entities: Entity[], groups: DocumentReadModel["groups"]): DocumentReadModel {
    return { revision: 1, entities, groups, constraints: [] };
  }
  function onLayer(e: Entity, layer: string): Entity {
    return { ...e, layer };
  }

  it("reports no issue for a clean, non-overlapping sheet", () => {
    const outline = onLayer(poly("outline", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]), NEST_SHEET_LAYER);
    const a = onLayer(poly("a", [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }]), NEST_PARTS_LAYER);
    const b = onLayer(poly("b", [{ x: 30, y: 30 }, { x: 40, y: 30 }, { x: 40, y: 40 }, { x: 30, y: 40 }]), NEST_PARTS_LAYER);
    const groups = [{ id: "g1", members: ["outline", "a", "b"], name: "Sheet 1" }];
    expect(checkNestOverlaps(model([outline, a, b], groups))).toEqual([]);
  });

  it("flags a sheet where two placed parts overlap after a drag", () => {
    const outline = onLayer(poly("outline", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]), NEST_SHEET_LAYER);
    const a = onLayer(poly("a", [{ x: 10, y: 10 }, { x: 25, y: 10 }, { x: 25, y: 25 }, { x: 10, y: 25 }]), NEST_PARTS_LAYER);
    const b = onLayer(poly("b", [{ x: 20, y: 20 }, { x: 35, y: 20 }, { x: 35, y: 35 }, { x: 20, y: 35 }]), NEST_PARTS_LAYER); // overlaps a
    const groups = [{ id: "g1", members: ["outline", "a", "b"], name: "Sheet 1" }];
    const issues = checkNestOverlaps(model([outline, a, b], groups));
    expect(issues).toEqual([{ groupName: "Sheet 1" }]);
  });

  it("still catches an overlap when the two parts are split across the parts and holes layers", () => {
    const outline = onLayer(poly("outline", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]), NEST_SHEET_LAYER);
    const a = onLayer(poly("a", [{ x: 10, y: 10 }, { x: 25, y: 10 }, { x: 25, y: 25 }, { x: 10, y: 25 }]), NEST_PARTS_LAYER);
    const b = onLayer(poly("b", [{ x: 20, y: 20 }, { x: 35, y: 20 }, { x: 35, y: 35 }, { x: 20, y: 35 }]), NEST_HOLES_LAYER);
    const groups = [{ id: "g1", members: ["outline", "a", "b"], name: "Sheet 1" }];
    expect(checkNestOverlaps(model([outline, a, b], groups))).toEqual([{ groupName: "Sheet 1" }]);
  });

  it("ignores groups that aren't entirely on the nest engine's layers", () => {
    const other: Entity = { id: "x", type: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true };
    const groups = [{ id: "g1", members: ["x"], name: "Not a nest group" }];
    expect(checkNestOverlaps(model([other], groups))).toEqual([]);
  });
});
