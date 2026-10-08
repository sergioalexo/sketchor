/**
 * Why this matters: dropping a library part into a drawing must bring along
 * the blocks it nests (or it renders as markers) and must never overwrite a
 * block the user already edited in this drawing unless they ask to redefine.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { LineEntity } from "../entities";
import { blockFromEntities, blockPreviewEntities, instanceCounts, libraryEntry, planLibraryImport, sanitizeBlockName } from "./library";
import { makeInsert } from "./ops";

const line = (id: string, len: number): LineEntity => ({ id, type: "line", a: { x: 0, y: 0 }, b: { x: len, y: 0 } });

function drawingWithNested() {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  bus.execute({ type: "put-table-record", table: "blocks", record: blockFromEntities("INNER", [line("a", 5)]) });
  bus.execute({ type: "put-table-record", table: "blocks", record: blockFromEntities("OUTER", [makeInsert("n", "INNER", { x: 1, y: 0 })]) });
  bus.execute({ type: "add-entity", entity: makeInsert("i1", "OUTER", { x: 0, y: 0 }) });
  bus.execute({ type: "add-entity", entity: makeInsert("i2", "OUTER", { x: 9, y: 0 }) });
  return { doc, bus };
}

describe("block library", () => {
  it("counts top-level instances per block", () => {
    const { doc } = drawingWithNested();
    expect(instanceCounts(doc).get("OUTER")).toBe(2);
    expect(instanceCounts(doc).get("INNER")).toBeUndefined();
  });

  it("an entry carries nested blocks and imports into an empty drawing", () => {
    const { doc } = drawingWithNested();
    const entry = libraryEntry(doc, "OUTER")!;
    expect(entry.deps.map((d) => d.name)).toEqual(["INNER"]);
    const target = new SketchDocument();
    const tbus = new CommandBus(target);
    for (const c of planLibraryImport(target, entry)) tbus.execute(c);
    expect(target.hasRecord("blocks", "INNER") && target.hasRecord("blocks", "OUTER")).toBe(true);
    expect(blockPreviewEntities(target, "OUTER")).toHaveLength(1);
    expect(libraryEntry(doc, "NOPE")).toBeNull();
  });

  it("importing again leaves local edits alone, redefine replaces them", () => {
    const { doc, bus } = drawingWithNested();
    const entry = libraryEntry(doc, "INNER")!;
    bus.execute({ type: "update-block", name: "INNER", changes: { entities: [line("a", 50)] } });
    expect(planLibraryImport(doc, entry)).toEqual([]);
    const redefine = planLibraryImport(doc, entry, true);
    expect(redefine).toHaveLength(1);
    bus.execute(redefine[0]);
    expect((doc.getRecord("blocks", "INNER") as unknown as { entities: LineEntity[] }).entities[0].b.x).toBe(5);
  });

  it("makes safe block names from file names", () => {
    expect(sanitizeBlockName("Door 36in.dxf")).toBe("Door_36in");
    expect(sanitizeBlockName("   ")).toBe("BLOCK");
    expect(sanitizeBlockName("a/b:c*d")).toBe("abcd");
  });
});
