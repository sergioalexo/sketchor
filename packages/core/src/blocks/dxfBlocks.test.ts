/**
 * Why this matters: a DXF full of repeated parts (symbols, title blocks) must
 * import as definitions + references, not thousands of loose lines — and the
 * kept form must draw exactly what expanding it would have drawn, in the
 * file's own units, with attribute values intact. A cycle in the file must not
 * hang the evaluator.
 */
import { describe, expect, it } from "vitest";
import { SketchDocument } from "../document";
import { boundsOf } from "../dxf";
import { parseDxf } from "../dxf";
import type { InsertEntity } from "../entities";
import { withBlocks } from "./context";
import { flattenInserts } from "./evaluate";
import "../kinds/builtin";

type Pairs = (number | string)[][];
const text = (pairs: Pairs) => pairs.map(([c, v]) => `${c}\n${v}`).join("\n") + "\n0\nEOF\n";
const rec = (type: string, ...pairs: Pairs): Pairs => [[0, type], ...pairs];
const section = (name: string, ...recs: Pairs[]): Pairs => [[0, "SECTION"], [2, name], ...recs.flat(), [0, "ENDSEC"]];
const block = (name: string, base: [number, number], ...body: Pairs[]): Pairs[] => [
  rec("BLOCK", [2, name], [10, base[0]], [20, base[1]]),
  ...body,
  rec("ENDBLK"),
];
const line = (x1: number, y1: number, x2: number, y2: number): Pairs => rec("LINE", [8, "0"], [10, x1], [20, y1], [11, x2], [21, y2]);

function docOf(r: ReturnType<typeof parseDxf>): SketchDocument {
  const d = new SketchDocument();
  for (const b of r.blocks) d._putRecord("blocks", b);
  for (const e of r.entities) d._put(e);
  return d;
}

describe("DXF import keeps blocks (B-07)", () => {
  const file = (units?: number) =>
    text([
      ...(units !== undefined ? section("HEADER", [[9, "$INSUNITS"], [70, units]]) : []),
      ...section("BLOCKS", ...block("SQ", [1, 0], line(1, 0, 11, 0), line(11, 0, 11, 5))),
      ...section(
        "ENTITIES",
        rec("INSERT", [8, "PARTS"], [2, "SQ"], [10, 100], [20, 50], [41, 2], [42, 1], [50, 90], [70, 2], [71, 1], [44, 30], [45, 0]),
      ),
    ]);

  it("keeps the definition and one insert with its placement and array", () => {
    const r = parseDxf(file());
    expect(r.blocks.map((b) => b.name)).toEqual(["SQ"]);
    expect(r.blocks[0].basePoint).toEqual({ x: 1, y: 0 });
    expect(r.entities).toHaveLength(1);
    const ins = r.entities[0] as InsertEntity;
    expect(ins).toMatchObject({ type: "insert", block: "SQ", layer: "PARTS", insert: { x: 100, y: 50 }, scale: { x: 2, y: 1 }, array: { cols: 2, rows: 1, colSpacing: 30 } });
    expect(ins.rotation).toBeCloseTo(Math.PI / 2);
  });

  it.each([undefined, 1, 4])("draws exactly what expanding in place draws (units %s)", (units) => {
    const kept = parseDxf(file(units));
    const exploded = parseDxf(file(units), { blocks: "explode" });
    expect(exploded.blocks).toEqual([]);
    const flat = withBlocks(docOf(kept), () => flattenInserts(docOf(kept), kept.entities));
    const a = boundsOf(flat)!;
    const b = boundsOf(exploded.entities)!;
    for (const k of ["minX", "minY", "maxX", "maxY"] as const) expect(a[k]).toBeCloseTo(b[k], 6);
  });

  it("reads attribute definitions and the values that follow an INSERT", () => {
    const r = parseDxf(
      text([
        ...section(
          "BLOCKS",
          ...block("TB", [0, 0], line(0, 0, 10, 0), rec("ATTDEF", [2, "PART"], [3, "Part no."], [1, "?"], [10, 1], [20, 2], [40, 3], [70, 2])),
        ),
        ...section(
          "ENTITIES",
          rec("INSERT", [2, "TB"], [10, 0], [20, 0], [66, 1]),
          rec("ATTRIB", [2, "PART"], [1, "A-17"], [10, 1], [20, 2], [40, 3]),
          rec("SEQEND"),
          line(0, 0, 1, 1),
        ),
      ]),
    );
    expect(r.blocks[0].attributeDefs[0]).toMatchObject({ tag: "PART", prompt: "Part no.", default: "?", at: { x: 1, y: 2 }, height: 3, flags: { constant: true, invisible: false } });
    expect((r.entities[0] as InsertEntity).attributes).toEqual({ PART: "A-17" });
    expect(r.entities).toHaveLength(2); // the ATTRIB did not also become loose text
    expect(parseDxf(text([...section("ENTITIES", rec("ATTRIB", [1, "hi"], [10, 3], [20, 4], [40, 2]))])).entities[0]).toMatchObject({ type: "text", text: "hi" });
  });

  it("cuts a self-nesting block instead of hanging, and expands anonymous blocks in place", () => {
    const r = parseDxf(
      text([
        ...section(
          "BLOCKS",
          ...block("A", [0, 0], line(0, 0, 1, 0), rec("INSERT", [2, "B"], [10, 0], [20, 0])),
          ...block("B", [0, 0], rec("INSERT", [2, "A"], [10, 0], [20, 0])),
          ...block("*U7", [0, 0], line(0, 0, 5, 5)),
        ),
        ...section("ENTITIES", rec("INSERT", [2, "A"], [10, 0], [20, 0]), rec("INSERT", [2, "*U7"], [10, 10], [20, 0])),
      ]),
    );
    expect(r.warnings.some((w) => w.includes("nests itself"))).toBe(true);
    expect(r.blocks.map((b) => b.name).sort()).toEqual(["A", "B"]);
    const d = docOf(r);
    expect(() => withBlocks(d, () => flattenInserts(d, r.entities))).not.toThrow();
    expect(r.entities.filter((e) => e.type === "line")).toHaveLength(1); // *U7 expanded
  });

  it("an INSERT of a block the file never defines is reported, not fatal", () => {
    const r = parseDxf(text([...section("ENTITIES", rec("INSERT", [2, "GHOST"], [10, 0], [20, 0]))]));
    expect(r.entities).toEqual([]);
    expect(r.warnings.some((w) => w.includes("GHOST"))).toBe(true);
  });
});
