import { describe, expect, it } from "vitest";
import { SketchDocument } from "./document";
import type { LineEntity } from "./entities";
import { layerList, layerRecordWith } from "./layerTable";

/**
 * The layer list the UI shows is a projection of the document (Z-02). What
 * breaks if it regresses: a layer used by geometry but missing from the panel
 * (so it cannot be hidden), a hidden layer that reappears on save/load, or the
 * default layer losing its place at the top.
 */

const line = (id: string, layer?: string): LineEntity => ({ id, type: "line", ...(layer ? { layer } : {}), a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });

describe("layerList", () => {
  it("always leads with the default layer, even in an empty document", () => {
    expect(layerList(new SketchDocument())).toEqual([{ name: "0", visible: true }]);
  });

  it("shows layers that only entities mention, as visible and unlocked, in first-use order", () => {
    const doc = new SketchDocument();
    doc._put(line("a", "walls"));
    doc._put(line("b", "doors"));
    doc._put(line("c", "walls"));
    expect(layerList(doc).map((l) => l.name)).toEqual(["0", "walls", "doors"]);
    expect(layerList(doc).every((l) => l.visible && !l.locked)).toBe(true);
  });

  it("applies recorded visibility and lock, and lists recorded empty layers", () => {
    const doc = new SketchDocument();
    doc._put(line("a", "walls"));
    doc._putRecord("layers", { name: "walls", visible: false, locked: true });
    doc._putRecord("layers", { name: "spare", visible: true });
    expect(layerList(doc)).toEqual([
      { name: "0", visible: true },
      { name: "walls", visible: false, locked: true },
      { name: "spare", visible: true },
    ]);
  });

  it("survives save and load with the same state", () => {
    const doc = new SketchDocument();
    doc._put(line("a", "walls"));
    doc._putRecord("layers", { name: "walls", visible: false });
    const back = SketchDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(layerList(back)).toEqual(layerList(doc));
  });

  it("can hide the default layer too", () => {
    const doc = new SketchDocument();
    doc._putRecord("layers", { name: "0", visible: false });
    expect(layerList(doc)).toEqual([{ name: "0", visible: false }]);
  });
});

describe("layerRecordWith", () => {
  it("starts a missing layer visible and unlocked, then layers the patch on", () => {
    const doc = new SketchDocument();
    expect(layerRecordWith(doc, "x", {})).toEqual({ name: "x", visible: true });
    expect(layerRecordWith(doc, "x", { locked: true })).toEqual({ name: "x", visible: true, locked: true });
  });

  it("keeps fields the patch does not mention, and the name is not patchable", () => {
    const doc = new SketchDocument();
    doc._putRecord("layers", { name: "x", visible: false, color: "#f00" });
    expect(layerRecordWith(doc, "x", { locked: true })).toEqual({ name: "x", visible: false, color: "#f00", locked: true });
  });
});
