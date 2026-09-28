import { describe, expect, it } from "vitest";
import { CommandBus } from "./commands";
import { SketchDocument } from "./document";
import type { Entity, LineEntity } from "./entities";
import { registerRecordRefRewriter, sanitizeRecords, type TableRecord } from "./tables";

/**
 * Document tables and settings (Z-02). What breaks in a user's drawing if this
 * regresses: renaming a layer strands its geometry on a name that no longer has
 * a record (it reappears as a phantom layer), an undo leaves half a rename
 * behind, an older file fails to open in the new format, or a file from a newer
 * build with a table we don't know is refused instead of opened.
 */

const line = (id: string, layer?: string): LineEntity => ({ id, type: "line", ...(layer ? { layer } : {}), a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });

function fixture() {
  const doc = new SketchDocument();
  doc._put(line("e1", "walls"));
  doc._put(line("e2", "walls"));
  doc._put(line("e3", "doors"));
  doc._put(line("e4")); // default layer
  doc._putRecord("layers", { name: "walls", visible: true });
  doc._putRecord("layers", { name: "doors", visible: true });
  return { doc, bus: new CommandBus(doc) };
}

describe("table commands", () => {
  it("put-table-record inserts, then replaces in place", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "put-table-record", table: "layers", record: { name: "roof", visible: true } });
    expect(doc.records("layers").map((r) => r.name)).toEqual(["walls", "doors", "roof"]);
    bus.execute({ type: "put-table-record", table: "layers", record: { name: "walls", visible: false } });
    expect(doc.records("layers").map((r) => r.name)).toEqual(["walls", "doors", "roof"]); // same slot
    expect(doc.getRecord("layers", "walls")).toEqual({ name: "walls", visible: false });
  });

  it("delete-table-record undoes into its old position, not the end", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "put-table-record", table: "layers", record: { name: "roof", visible: true } });
    bus.execute({ type: "delete-table-record", table: "layers", name: "walls" });
    expect(doc.records("layers").map((r) => r.name)).toEqual(["doors", "roof"]);
    bus.undo();
    expect(doc.records("layers").map((r) => r.name)).toEqual(["walls", "doors", "roof"]);
  });

  it("deleting a record that does not exist is a no-op that leaves no undo entry to trip over", () => {
    const { doc, bus } = fixture();
    const before = doc.revision;
    bus.execute({ type: "delete-table-record", table: "layers", name: "nope" });
    expect(doc.revision).toBe(before);
    bus.undo(); // undoes the (empty) entry — nothing to restore, nothing thrown
    expect(doc.records("layers")).toHaveLength(2);
  });

  it("rename-table-record rewrites every entity that named the layer, in one undo step", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "rename-table-record", table: "layers", from: "walls", to: "structure" });
    expect(doc.get("e1")!.layer).toBe("structure");
    expect(doc.get("e2")!.layer).toBe("structure");
    expect(doc.get("e3")!.layer).toBe("doors");
    expect(doc.get("e4")!.layer).toBeUndefined();
    expect(doc.getRecord("layers", "structure")).toEqual({ name: "structure", visible: true });
    expect(doc.hasRecord("layers", "walls")).toBe(false);
    expect(doc.records("layers").map((r) => r.name)).toEqual(["structure", "doors"]); // position kept

    bus.undo();
    expect(doc.get("e1")!.layer).toBe("walls");
    expect(doc.get("e2")!.layer).toBe("walls");
    expect(doc.hasRecord("layers", "walls")).toBe(true);
    expect(doc.hasRecord("layers", "structure")).toBe(false);
    bus.redo();
    expect(doc.get("e1")!.layer).toBe("structure");
  });

  it("undoing a rename does not drag along entities that were already on the new name", () => {
    // "structure" is used by an entity with no record. Renaming walls→structure merges the two;
    // undo must still put e1/e2 back on "walls" and leave the pre-existing e5 on "structure".
    const { doc, bus } = fixture();
    doc._put(line("e5", "structure"));
    bus.execute({ type: "rename-table-record", table: "layers", from: "walls", to: "structure" });
    bus.undo();
    expect(doc.get("e1")!.layer).toBe("walls");
    expect(doc.get("e5")!.layer).toBe("structure");
  });

  it("refuses a rename onto an existing name, from a missing name, or to the same name", () => {
    const { doc, bus } = fixture();
    const before = JSON.stringify(doc.toJSON());
    for (const [from, to] of [["walls", "doors"], ["ghost", "x"], ["walls", "walls"], ["walls", ""]]) {
      bus.execute({ type: "rename-table-record", table: "layers", from, to });
    }
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  it("rewrite:false renames the record and leaves entities alone", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "rename-table-record", table: "layers", from: "walls", to: "structure", rewrite: false });
    expect(doc.get("e1")!.layer).toBe("walls");
    expect(doc.hasRecord("layers", "structure")).toBe(true);
  });

  it("records that point at another table are rewritten too, and restored on undo", () => {
    // A future item (e.g. a layer's linetype) registers how its records reference a table.
    registerRecordRefRewriter("linetypes", "layers", (rec, from, to) => (rec.linetype === from ? { ...rec, linetype: to } : null));
    const { doc, bus } = fixture();
    doc._putRecord("linetypes", { name: "DASHED", pattern: [4, 2] });
    doc._putRecord("layers", { name: "hidden", visible: true, linetype: "DASHED" });
    bus.execute({ type: "rename-table-record", table: "linetypes", from: "DASHED", to: "DASH" });
    expect(doc.getRecord("layers", "hidden")!.linetype).toBe("DASH");
    bus.undo();
    expect(doc.getRecord("layers", "hidden")!.linetype).toBe("DASHED");
    expect(doc.hasRecord("linetypes", "DASHED")).toBe(true);
  });

  it("set-settings merges, removes on null, and undoes both", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "set-settings", patch: { insUnits: 4, ltscale: 2 } });
    bus.execute({ type: "set-settings", patch: { ltscale: null as unknown as undefined, currentDimStyle: "ISO-25" } });
    expect(doc.settings).toEqual({ insUnits: 4, currentDimStyle: "ISO-25" });
    bus.undo();
    expect(doc.settings).toEqual({ insUnits: 4, ltscale: 2 });
    bus.undo();
    expect(doc.settings).toEqual({});
  });

  it("table edits bump tablesRevision; entity edits do not", () => {
    const { doc, bus } = fixture();
    const t = doc.tablesRevision;
    bus.execute({ type: "add-entity", entity: line("e9") });
    expect(doc.tablesRevision).toBe(t);
    bus.execute({ type: "put-table-record", table: "layers", record: { name: "x", visible: true } });
    expect(doc.tablesRevision).toBeGreaterThan(t);
  });

  it("commands are plain JSON: a table command survives a serialise/parse round trip", () => {
    const { doc, bus } = fixture();
    const cmd = JSON.parse(JSON.stringify({ type: "rename-table-record", table: "layers", from: "walls", to: "w" }));
    bus.execute(cmd);
    expect(doc.get("e1")!.layer).toBe("w");
  });
});

describe("document format v3", () => {
  it("reads a v1 file (entities only) unchanged, with empty tables", () => {
    const doc = SketchDocument.fromJSON({ entities: [line("e1", "walls")] });
    expect(doc.all()).toEqual([line("e1", "walls")]);
    expect(doc.tableNames()).toEqual([]);
    expect(doc.settings).toEqual({});
  });

  it("reads a v2 file (groups + constraints, no tables) unchanged", () => {
    const v2 = {
      version: 2,
      entities: [line("e1"), line("e2")],
      groups: [{ id: "g1", name: "Plate", members: ["e1", "e2"] }],
      constraints: [{ id: "k1", type: "horizontal", entityId: "e1" }],
    };
    const doc = SketchDocument.fromJSON(v2 as never);
    expect(doc.all()).toHaveLength(2);
    expect(doc.getGroup("g1")!.members).toEqual(["e1", "e2"]);
    expect(doc.getConstraint("k1")).toBeDefined();
    const out = doc.toJSON();
    expect(out.version).toBe(3);
    expect(out.entities).toEqual(v2.entities);
    expect(out.tables).toEqual({});
  });

  it("keeps a table it does not know about (a newer build's) and writes it back", () => {
    const doc = SketchDocument.fromJSON({
      version: 4,
      entities: [],
      tables: { futureThing: [{ name: "a", x: 1 }], layers: [{ name: "L", visible: true }] },
    } as never);
    expect(doc.getRecord("futureThing", "a")).toEqual({ name: "a", x: 1 });
    expect(doc.toJSON().tables.futureThing).toEqual([{ name: "a", x: 1 }]);
  });

  it("survives malformed tables and settings without throwing", () => {
    const bad = [
      { entities: [], tables: null },
      { entities: [], tables: [] },
      { entities: [], tables: { layers: "nope" } },
      { entities: [], tables: { layers: [null, 3, "x", [], {}, { name: 5 }, { name: "" }, { name: "ok", visible: true }, { name: "ok", visible: false }] } },
      { entities: [], settings: "no" },
      { entities: [], settings: [1, 2] },
      { entities: [], settings: null },
    ];
    for (const json of bad) expect(() => SketchDocument.fromJSON(json as never)).not.toThrow();
    const doc = SketchDocument.fromJSON(bad[3] as never);
    expect(doc.records("layers")).toEqual([{ name: "ok", visible: true }]); // junk dropped, first duplicate wins
  });

  it("sanitizeRecords tolerates any input", () => {
    for (const v of [undefined, null, 1, "s", {}, [], [undefined]]) expect(sanitizeRecords(v)).toEqual([]);
    const rec: TableRecord = { name: "a" };
    expect(sanitizeRecords([rec])).toEqual([rec]);
  });

  it("is idempotent: a document survives repeated save/load", () => {
    const { doc } = fixture();
    doc._patchSettings({ insUnits: 4 });
    let json = JSON.stringify(doc.toJSON());
    for (let i = 0; i < 3; i++) json = JSON.stringify(SketchDocument.fromJSON(JSON.parse(json)).toJSON());
    expect(json).toBe(JSON.stringify(doc.toJSON()));
  });

  it("an Entity type is not required to carry any table reference", () => {
    // Guards the rewriter contract: an entity with no `layer` is on layer "0" and is never rewritten.
    const e: Entity = line("solo");
    const { doc, bus } = fixture();
    doc._put(e);
    bus.execute({ type: "rename-table-record", table: "layers", from: "walls", to: "w2" });
    expect(doc.get("solo")).toEqual(e);
  });
});
