/**
 * Why this matters: saving must not explode every part of a drawing back into
 * loose lines (file size, and the next person's "select all instances"). The
 * written BLOCKS/INSERT/ATTRIB structure has to read back as the same
 * definitions, placements, attribute values and — evaluated — the same
 * geometry, in both DXF flavours and in a non-mm unit.
 */
import { describe, expect, it } from "vitest";
import { SketchDocument } from "../document";
import { boundsOf, parseDxf } from "../dxf";
import { entitiesToDxf } from "../dxfExport";
import { entitiesToDxf2018 } from "../dxfw";
import type { InsertEntity, LineEntity } from "../entities";
import "../kinds/builtin";
import { withBlocks } from "./context";
import { flattenInserts } from "./evaluate";
import { makeInsert } from "./ops";
import type { BlockDefinition } from "./types";

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

function drawing() {
  const part: BlockDefinition = {
    name: "PART",
    basePoint: { x: 2, y: 1 },
    entities: [line("a", 2, 1, 12, 1), line("b", 12, 1, 12, 6)],
    attributeDefs: [
      { tag: "NO", prompt: "Part number", default: "P-0", at: { x: 3, y: 2 }, height: 2, rotation: 0 },
      { tag: "MAT", at: { x: 3, y: 4 }, height: 2, rotation: 0, default: "steel", flags: { constant: true } },
    ],
    explodable: true,
    scaleUniformly: false,
  };
  const outer: BlockDefinition = {
    name: "OUTER",
    basePoint: { x: 0, y: 0 },
    entities: [makeInsert("n", "PART", { x: 20, y: 0 }, { rotation: Math.PI / 2 })],
    attributeDefs: [],
    explodable: true,
    scaleUniformly: false,
  };
  const doc = new SketchDocument();
  doc._putRecord("blocks", part);
  doc._putRecord("blocks", outer);
  const entities = [
    makeInsert("i1", "PART", { x: 100, y: 50 }, { scale: { x: 2, y: 2 }, rotation: Math.PI / 6, attributes: { NO: "A-17" }, layer: "PARTS" }),
    makeInsert("i2", "PART", { x: 0, y: 0 }, { array: { cols: 3, rows: 2, colSpacing: 15, rowSpacing: 10 } }),
    makeInsert("i3", "OUTER", { x: -40, y: 5 }),
    line("l", 0, 0, 1, 1),
  ];
  for (const e of entities) doc._put(e);
  return { doc, entities, blocks: [part, outer] };
}

const flatBounds = (doc: SketchDocument, entities: readonly InsertEntity[] | readonly import("../entities").Entity[]) =>
  boundsOf(withBlocks(doc, () => flattenInserts(doc, entities as never)))!;

describe.each([
  ["AC1032", (e: never, blocks: BlockDefinition[], insUnits: number, scale: number) => entitiesToDxf2018(e, { blocks, insUnits, scale })],
  ["R12", (e: never, blocks: BlockDefinition[], insUnits: number, scale: number) => entitiesToDxf(e, insUnits, scale, blocks)],
])("block-aware DXF writer (%s)", (_name, write) => {
  it("writes BLOCKS + INSERT and reads back the same definitions, placements and attributes", () => {
    const { entities, blocks } = drawing();
    const text = write(entities as never, blocks, 4, 1);
    expect(text).toContain("\n2\nPART\n");
    expect(text.match(/\nINSERT\n/g)).toHaveLength(4); // three in the drawing, one nested inside OUTER
    const back = parseDxf(text);
    expect(back.blocks.map((b) => b.name).sort()).toEqual(["OUTER", "PART"]);
    const part = back.blocks.find((b) => b.name === "PART")!;
    expect(part.basePoint).toEqual({ x: 2, y: 1 });
    expect(part.attributeDefs.map((a) => a.tag)).toEqual(["NO", "MAT"]);
    expect(part.attributeDefs[0]).toMatchObject({ prompt: "Part number", default: "P-0" });
    expect(part.attributeDefs[1].flags?.constant).toBe(true);
    const inserts = back.entities.filter((e): e is InsertEntity => e.type === "insert");
    expect(inserts).toHaveLength(3);
    const i1 = inserts.find((i) => i.insert.x === 100)!;
    expect(i1).toMatchObject({ block: "PART", layer: "PARTS", scale: { x: 2, y: 2 }, attributes: { NO: "A-17" } });
    expect(i1.rotation).toBeCloseTo(Math.PI / 6, 5);
    expect(inserts.find((i) => i.array)!.array).toMatchObject({ cols: 3, rows: 2, colSpacing: 15, rowSpacing: 10 });
  });

  it("evaluates to the same geometry after a round trip, also in inches", () => {
    const { doc, entities, blocks } = drawing();
    const before = flatBounds(doc, entities);
    for (const [insUnits, scale] of [[4, 1], [1, 1 / 25.4]] as const) {
      const back = parseDxf(write(entities as never, blocks, insUnits, scale));
      const d2 = new SketchDocument();
      for (const b of back.blocks) d2._putRecord("blocks", b);
      const after = flatBounds(d2, back.entities as never);
      for (const k of ["minX", "minY", "maxX", "maxY"] as const) expect(after[k]).toBeCloseTo(before[k], 3);
    }
  });

  it("an insert of a block that was not supplied writes nothing instead of a dangling reference", () => {
    const text = write([makeInsert("x", "NOPE", { x: 0, y: 0 })] as never, [], 4, 1);
    expect(text).not.toContain("\nINSERT\n");
  });
});

describe("AC1032 block structure", () => {
  it("gives every definition a BLOCK_RECORD and owns its body by it", () => {
    const { entities, blocks } = drawing();
    const text = entitiesToDxf2018(entities, { blocks });
    const rec = /0\nBLOCK_RECORD\n5\n([0-9A-F]+)\n[\s\S]*?2\nPART\n/.exec(text);
    expect(rec).not.toBeNull();
    const handle = rec![1];
    // The BLOCK begin and the body lines name that record as owner (group 330).
    expect(text.split(`330\n${handle}\n`).length).toBeGreaterThan(4);
    expect(text).toContain("0\nATTRIB\n");
    expect(text).toContain("0\nSEQEND\n");
    expect(text).toContain("0\nATTDEF\n");
  });
});
