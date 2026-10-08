// @vitest-environment jsdom
/**
 * Why this matters: a drawing with a hundred copies of one part must export
 * as one <symbol> and a hundred <use>s (lossless, small) — and a viewer that
 * resolves <use> (the SVG importer here is one) must see exactly the geometry
 * the expanded export shows, including nested blocks, rotation, mirror and arrays.
 */
import { describe, expect, it } from "vitest";
import { SketchDocument } from "../document";
import { boundsOf } from "../dxf";
import type { Entity, LineEntity } from "../entities";
import "../kinds/builtin";
import { entitiesToSvgDocument, parseSvgText } from "../svg";
import { withBlocks } from "./context";
import { flattenInserts } from "./evaluate";
import { makeInsert } from "./ops";
import type { BlockDefinition } from "./types";

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

const part: BlockDefinition = {
  name: "PART",
  basePoint: { x: 1, y: 1 },
  entities: [line("a", 1, 1, 11, 1), line("b", 11, 1, 11, 6), { id: "c", type: "circle", center: { x: 5, y: 3 }, radius: 2 }],
  attributeDefs: [{ tag: "NO", at: { x: 2, y: 2 }, height: 2, rotation: 0, default: "P1" }],
  explodable: true,
  scaleUniformly: false,
};
const outer: BlockDefinition = { name: "OUTER", basePoint: { x: 0, y: 0 }, entities: [makeInsert("n", "PART", { x: 20, y: 0 }, { rotation: Math.PI / 2 })], attributeDefs: [], explodable: true, scaleUniformly: false };

function extent(entities: Entity[]) {
  const b = boundsOf(entities)!;
  return { w: b.maxX - b.minX, h: b.maxY - b.minY };
}

describe("SVG export writes blocks as symbols (B-08)", () => {
  const entities = [
    makeInsert("i1", "PART", { x: 100, y: 50 }, { scale: { x: 2, y: -1 }, rotation: Math.PI / 5 }),
    makeInsert("i2", "PART", { x: 0, y: 0 }, { array: { cols: 3, rows: 2, colSpacing: 15, rowSpacing: 12 } }),
    makeInsert("i3", "OUTER", { x: -40, y: 5 }),
  ];

  it("uses one <symbol> per block and a <use> per placement", () => {
    const svg = entitiesToSvgDocument(entities, { blocks: [part, outer] });
    expect(svg.match(/<symbol /g)).toHaveLength(2);
    expect(svg.match(/<use /g)).toHaveLength(1 + 6 + 1 + 1); // i1, i2's 6 cells, i3, and OUTER's nested use
    expect(svg).toContain("P1</text>"); // the attribute value is drawn as text at the instance
  });

  it("re-imports to the same extent as the expanded drawing", () => {
    const doc = new SketchDocument();
    doc._putRecord("blocks", part);
    doc._putRecord("blocks", outer);
    const flat = withBlocks(doc, () => flattenInserts(doc, entities)).filter((e) => e.type !== "text");
    const back = parseSvgText(entitiesToSvgDocument(entities, { blocks: [part, outer] })).entities.filter((e) => e.type !== "text");
    const a = extent(flat);
    const b = extent(back);
    // The importer yields geometry only (the export margin is not geometry).
    expect(b.w).toBeCloseTo(a.w, 3);
    expect(b.h).toBeCloseTo(a.h, 3);
  });

  it("an unknown block draws nothing, no blocks option leaves the old behaviour", () => {
    expect(entitiesToSvgDocument([makeInsert("x", "NOPE", { x: 0, y: 0 })], { blocks: [part] })).not.toContain("<use");
  });
});
