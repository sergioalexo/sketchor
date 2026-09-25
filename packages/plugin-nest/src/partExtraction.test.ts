import { describe, expect, it } from "vitest";
import type { CircleEntity, Entity, LineEntity, PolylineEntity } from "@sketchor/core";
import { extractParts } from "./partExtraction";

/**
 * N-01: the panel's part list has to reflect what a laser actually cuts —
 * a hole stays a hole, and a part someone drew inside a hole (for later
 * part-in-hole filling) mustn't get folded into that hole's data. These
 * tests pin the containment classification, not just "some polygon came
 * out" — a wrong depth here silently cuts a part in half on the sheet.
 */

function rectPolyline(id: string, x: number, y: number, w: number, h: number, name?: string): PolylineEntity {
  return {
    id,
    type: "polyline",
    name,
    closed: true,
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  };
}

function allIds(entities: Entity[]): Set<string> {
  return new Set(entities.map((e) => e.id));
}

describe("extractParts", () => {
  it("a rectangle with one square hole becomes one part with one hole", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 50, "Plate");
    const hole = rectPolyline("hole", 20, 10, 10, 10);
    const entities = [outer, hole];
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("Plate");
    expect(parts[0].holes).toHaveLength(1);
    expect(parts[0].sourceIds.sort()).toEqual(["hole", "outer"]);
    expect(parts[0].outerSourceIds).toEqual(["outer"]);
    expect(parts[0].holeSourceIds).toEqual([["hole"]]);
  });

  it("two separate holes in one outer shape both attach to it", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 50);
    const holeA = rectPolyline("holeA", 10, 10, 5, 5);
    const holeB = rectPolyline("holeB", 60, 30, 5, 5);
    const entities = [outer, holeA, holeB];
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(1);
    expect(parts[0].holes).toHaveLength(2);
    expect(parts[0].outerSourceIds).toEqual(["outer"]);
    expect(parts[0].holeSourceIds.map((ids) => ids.slice().sort())).toEqual(
      expect.arrayContaining([["holeA"], ["holeB"]]),
    );
  });

  it("a shape nested inside a hole becomes its own part, not a hole of a hole", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 100);
    const hole = rectPolyline("hole", 20, 20, 40, 40);
    const inner = rectPolyline("inner", 30, 30, 10, 10);
    const entities = [outer, hole, inner];
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(2);
    const outerPart = parts.find((p) => p.sourceIds.includes("outer"))!;
    const innerPart = parts.find((p) => p.sourceIds.includes("inner"))!;
    expect(outerPart.holes).toHaveLength(1);
    expect(outerPart.sourceIds).not.toContain("inner");
    expect(innerPart.holes).toHaveLength(0);
    expect(innerPart.sourceIds).toEqual(["inner"]);
  });

  it("an open, non-closing chain in the selection is ignored rather than thrown", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 50);
    const strayLine: LineEntity = { id: "stray", type: "line", a: { x: 200, y: 200 }, b: { x: 210, y: 210 } };
    const entities: Entity[] = [outer, strayLine];
    expect(() => extractParts(entities, allIds(entities))).not.toThrow();
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(1);
    expect(parts[0].sourceIds).toEqual(["outer"]);
  });

  it("open line/arc chains that close into a loop become a part", () => {
    // A square drawn as four separate lines rather than a closed polyline.
    const lines: LineEntity[] = [
      { id: "l1", type: "line", a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
      { id: "l2", type: "line", a: { x: 20, y: 0 }, b: { x: 20, y: 20 } },
      { id: "l3", type: "line", a: { x: 20, y: 20 }, b: { x: 0, y: 20 } },
      { id: "l4", type: "line", a: { x: 0, y: 20 }, b: { x: 0, y: 0 } },
    ];
    const parts = extractParts(lines, allIds(lines));
    expect(parts).toHaveLength(1);
    expect(parts[0].sourceIds.sort()).toEqual(["l1", "l2", "l3", "l4"]);
    expect(parts[0].outer.length).toBeGreaterThanOrEqual(4);
    // A closed outline joined from several entities: all of them are the
    // outer boundary's own ids, none are holes.
    expect(parts[0].outerSourceIds.slice().sort()).toEqual(["l1", "l2", "l3", "l4"]);
    expect(parts[0].holeSourceIds).toEqual([]);
  });

  it("a washer (circle with a circular hole) extracts correctly", () => {
    const outer: CircleEntity = { id: "o", type: "circle", center: { x: 0, y: 0 }, radius: 20 };
    const inner: CircleEntity = { id: "i", type: "circle", center: { x: 0, y: 0 }, radius: 5 };
    const entities = [outer, inner];
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(1);
    expect(parts[0].holes).toHaveLength(1);
  });

  it("only considers the given selection, ignoring unselected entities", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 50);
    const unrelated = rectPolyline("unrelated", 500, 500, 10, 10);
    const entities = [outer, unrelated];
    const parts = extractParts(entities, new Set(["outer"]));
    expect(parts).toHaveLength(1);
    expect(parts[0].sourceIds).toEqual(["outer"]);
  });
});
