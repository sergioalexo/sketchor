/**
 * Why this matters: title blocks and parts lists live in attribute values. A
 * wrong placement of the text, a field that doesn't refresh, or a CSV that
 * breaks on a comma puts wrong numbers into a customer's drawing or BOM.
 */
import { describe, expect, it } from "vitest";
import { SketchDocument } from "../document";
import type { InsertEntity, TextEntity } from "../entities";
import { attributeCsv, attributeTable, editableAttributes, withAttributeValues } from "./attributes";
import { evaluateInsert } from "./evaluate";
import { expandFields, setFieldContext } from "./fields";
import { makeInsert } from "./ops";
import type { BlockDefinition } from "./types";

function setup() {
  const doc = new SketchDocument();
  const def: BlockDefinition = {
    name: "TITLE",
    basePoint: { x: 0, y: 0 },
    entities: [],
    attributeDefs: [
      { tag: "PART", at: { x: 1, y: 2 }, height: 3, rotation: 0, default: "?" },
      { tag: "DATE", at: { x: 0, y: 0 }, height: 3, rotation: 0, fieldExpr: "{{filename}}" },
      { tag: "CONST", at: { x: 0, y: 0 }, height: 3, rotation: 0, default: "fixed", flags: { constant: true } },
      { tag: "HIDDEN", at: { x: 0, y: 0 }, height: 3, rotation: 0, default: "h", flags: { invisible: true } },
    ],
    explodable: true,
    scaleUniformly: false,
  };
  doc._putRecord("blocks", def);
  return doc;
}

describe("attribute values and fields", () => {
  it("expands known fields and leaves unknown ones visible", () => {
    expect(expandFields("{{sheet}}/{{sheets}} {{nope}}", { sheet: 2, sheets: 5 })).toBe("2/5 {{nope}}");
    expect(expandFields("{{FileName}}", { filename: "a.dxf" })).toBe("a.dxf");
  });

  it("an instance shows its values as text at the transformed attribute position", () => {
    const doc = setup();
    setFieldContext({ filename: "plan.dxf" });
    const ins = makeInsert("i", "TITLE", { x: 10, y: 10 }, { attributes: { PART: "A-1" }, scale: { x: 2, y: 2 } });
    const texts = evaluateInsert(doc, ins).filter((e): e is TextEntity => e.type === "text");
    expect(texts.map((t) => t.text).sort()).toEqual(["A-1", "fixed", "plan.dxf"]);
    const part = texts.find((t) => t.text === "A-1")!;
    expect(part.at).toEqual({ x: 12, y: 14 });
    expect(part.height).toBeCloseTo(6);
    // A field change shows on the next evaluation.
    setFieldContext({ filename: "other.dxf" });
    expect(evaluateInsert(doc, ins).some((e) => e.type === "text" && e.text === "other.dxf")).toBe(true);
  });

  it("constant attributes ignore instance values and are not editable", () => {
    const doc = setup();
    const ins = makeInsert("i", "TITLE", { x: 0, y: 0 }, { attributes: { CONST: "hacked" } });
    expect(evaluateInsert(doc, ins).some((e) => e.type === "text" && e.text === "hacked")).toBe(false);
    expect(editableAttributes(doc, ins).map((a) => a.tag)).toEqual(["PART", "DATE", "HIDDEN"]);
  });

  it("withAttributeValues sets and clears tags", () => {
    const ins = makeInsert("i", "TITLE", { x: 0, y: 0 }, { attributes: { PART: "x" } });
    expect(withAttributeValues(ins, { PART: "", DATE: "d" }).attributes).toEqual({ DATE: "d" });
  });
});

describe("attribute extraction", () => {
  it("one row per insert, one column per tag, CSV-quoted", () => {
    const doc = setup();
    setFieldContext({ filename: "f.dxf" });
    doc._put(makeInsert("a", "TITLE", { x: 1, y: 2 }, { attributes: { PART: 'Bolt, "M6"' } }) as InsertEntity);
    doc._put(makeInsert("b", "TITLE", { x: 3, y: 4 }, { rotation: Math.PI / 2 }));
    const t = attributeTable(doc);
    expect(t.headers).toEqual(["Block", "Handle", "Layer", "X", "Y", "Rotation", "PART", "DATE", "CONST", "HIDDEN"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1].slice(3, 6)).toEqual(["3", "4", "90"]);
    const csv = attributeCsv(t);
    expect(csv.split("\r\n")[1]).toContain('"Bolt, ""M6"""');
    expect(attributeTable(doc, { blocks: ["NONE"] }).rows).toEqual([]);
  });
});
