/**
 * Why this matters: a purge that removes a layer or block something still
 * uses corrupts the drawing, and a replace that creates a nesting cycle
 * hangs the evaluator. Counting must see array cells and nested copies.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { LineEntity } from "../entities";
import { blockFromEntities } from "./library";
import { blockCountCsv, blockCountTable, blockTree, instancesOf, planPurge, planReplaceBlock, purgeCandidates } from "./manage";
import { makeInsert } from "./ops";

const line = (id: string, len: number, layer?: string): LineEntity => ({ id, type: "line", a: { x: 0, y: 0 }, b: { x: len, y: 0 }, ...(layer ? { layer } : {}) });

function drawing() {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  bus.execute({ type: "put-table-record", table: "blocks", record: blockFromEntities("INNER", [line("a", 5, "BODY")]) });
  bus.execute({ type: "put-table-record", table: "blocks", record: blockFromEntities("OUTER", [makeInsert("n", "INNER", { x: 1, y: 0 }), makeInsert("n2", "INNER", { x: 3, y: 0 })]) });
  bus.execute({ type: "put-table-record", table: "blocks", record: blockFromEntities("SPARE", [line("s", 2)]) });
  bus.execute({ type: "put-table-record", table: "layers", record: { name: "0", visible: true } });
  bus.execute({ type: "put-table-record", table: "layers", record: { name: "BODY", visible: true } });
  bus.execute({ type: "put-table-record", table: "layers", record: { name: "EMPTY", visible: true } });
  bus.execute({ type: "add-entity", entity: makeInsert("i1", "OUTER", { x: 0, y: 0 }, { array: { cols: 2, rows: 3, colSpacing: 10, rowSpacing: 10 } }) });
  return { doc, bus };
}

describe("block management", () => {
  it("purge lists only unreferenced records, layers inside block bodies count as used", () => {
    const { doc } = drawing();
    const c = purgeCandidates(doc);
    expect(c.blocks).toEqual(["SPARE"]);
    expect(c.layers).toEqual(["EMPTY"]);
  });

  it("purge deletes them in one undo step and nothing is left to purge", () => {
    const { doc, bus } = drawing();
    const plan = planPurge(doc)!;
    bus.execute({ type: "batch", commands: plan });
    expect(doc.hasRecord("blocks", "SPARE")).toBe(false);
    expect(doc.hasRecord("layers", "EMPTY")).toBe(false);
    expect(planPurge(doc)).toBeNull();
    bus.undo();
    expect(doc.hasRecord("blocks", "SPARE")).toBe(true);
    expect(doc.hasRecord("layers", "EMPTY")).toBe(true);
  });

  it("counts array cells and nested copies", () => {
    const { doc } = drawing();
    const rows = blockCountTable(doc);
    expect(rows).toEqual([
      { block: "INNER", placed: 0, total: 12 },
      { block: "OUTER", placed: 6, total: 6 },
    ]);
    expect(blockCountCsv(rows)).toBe("Block,Placed,Total\r\nINNER,0,12\r\nOUTER,6,6\r\n");
  });

  it("replaces instances, keeps placement, refuses cycles and unknown blocks", () => {
    const { doc, bus } = drawing();
    expect(planReplaceBlock(doc, "OUTER", "NOPE")).toBeNull();
    expect(planReplaceBlock(doc, "OUTER", "OUTER")).toBeNull();
    const plan = planReplaceBlock(doc, "OUTER", "SPARE")!;
    bus.execute({ type: "batch", commands: plan });
    expect(instancesOf(doc, "SPARE")).toEqual(["i1"]);
    expect((doc.get("i1") as { array?: unknown }).array).toBeDefined();
    // INNER inside OUTER -> replacing INNER with OUTER would make OUTER contain itself.
    expect(planReplaceBlock(doc, "INNER", "OUTER")).toBeNull();
  });

  it("builds the nested tree", () => {
    const { doc } = drawing();
    expect(blockTree(doc, "OUTER")).toEqual([{ block: "INNER", count: 2, children: [] }]);
    expect(blockTree(doc, "MISSING")).toEqual([]);
  });
});
