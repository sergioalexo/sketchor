/**
 * Why this matters: the block editor edits a scratch copy of a definition and
 * mirrors it back. If the scratch document leaks the edited block into its own
 * table, or the body read back differs from what was edited, Save corrupts the
 * definition every instance shares.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { LineEntity } from "../entities";
import { blockEditChanges, blockEditDocument } from "./edit";
import { makeInsert } from "./ops";
import { getBlock } from "./evaluate";

describe("block edit session documents", () => {
  const setup = () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: { id: "l1", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } } as LineEntity });
    bus.execute({ type: "define-block", name: "A", basePoint: { x: 0, y: 0 }, ids: ["l1"], insertId: "i1" });
    return { doc, bus };
  };

  it("holds the definition's entities, without the edited block's own record", () => {
    const { doc } = setup();
    const scratch = blockEditDocument(doc, "A")!;
    expect(scratch.all().map((e) => e.id)).toEqual(["l1"]);
    expect(scratch.hasRecord("blocks", "A")).toBe(false);
    expect(blockEditDocument(doc, "NOPE")).toBeNull();
  });

  it("reads an edited body back, and one update-block saves it with one undo step", () => {
    const { doc, bus } = setup();
    const scratch = blockEditDocument(doc, "A")!;
    const sbus = new CommandBus(scratch);
    sbus.execute({ type: "add-entity", entity: { id: "l2", type: "line", a: { x: 0, y: 0 }, b: { x: 0, y: 5 } } as LineEntity });
    const changes = blockEditChanges(scratch);
    expect(changes.entities.map((e) => e.id).sort()).toEqual(["l1", "l2"]);
    bus.execute({ type: "update-block", name: "A", changes });
    expect(getBlock(doc, "A")!.entities).toHaveLength(2);
    bus.undo();
    expect(getBlock(doc, "A")!.entities).toHaveLength(1);
  });

  it("keeps other blocks available for nesting", () => {
    const { doc, bus } = setup();
    bus.execute({ type: "add-entity", entity: makeInsert("n", "A", { x: 0, y: 0 }) });
    bus.execute({ type: "define-block", name: "B", basePoint: { x: 0, y: 0 }, ids: ["n"], insertId: "i2" });
    const scratch = blockEditDocument(doc, "B")!;
    expect(scratch.hasRecord("blocks", "A")).toBe(true);
  });
});
