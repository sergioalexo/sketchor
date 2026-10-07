/**
 * Why this matters: a block definition is shared by every instance, so a wrong
 * placement matrix, a cyclic reference that recurses forever, or a command whose
 * inverse forgets a nested reference silently corrupts or hangs a whole drawing.
 * The evaluator, the cycle guards, the insert kind and the B-02 commands are
 * pinned here against hand-computed geometry.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { Entity, InsertEntity, LineEntity } from "../entities";
import { rotated, translated } from "../entities";
import { kindBounds, kindHitDistance, kindSnaps, kindTessellate, kindTransform } from "../kinds/registry";
import "../kinds/builtin";
import { diffToCommands, parseCode, toCode } from "../sketchtext";
import { parseClipboard, pasteCommands, serializeSelection } from "../clipboard";
import { loopFromPoints } from "../hatch/loops";
import { blockWouldCycle, evaluateInsert, flattenInserts } from "./evaluate";
import { withBlocks } from "./context";
import { explodeInsert, unusedBlocks } from "./ops";
import type { BlockDefinition } from "./types";

const line = (id: string, ax: number, ay: number, bx: number, by: number, over: Partial<LineEntity> = {}): LineEntity => ({
  id,
  type: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  ...over,
});

const def = (name: string, entities: Entity[], over: Partial<BlockDefinition> = {}): BlockDefinition => ({
  name,
  basePoint: { x: 0, y: 0 },
  entities,
  attributeDefs: [],
  explodable: true,
  scaleUniformly: false,
  ...over,
});

const ins = (id: string, block: string, x = 0, y = 0, over: Partial<InsertEntity> = {}): InsertEntity => ({
  id,
  type: "insert",
  block,
  insert: { x, y },
  scale: { x: 1, y: 1 },
  rotation: 0,
  attributes: {},
  ...over,
});

function docWith(blocks: BlockDefinition[], entities: Entity[] = []): { doc: SketchDocument; bus: CommandBus } {
  const doc = new SketchDocument();
  for (const b of blocks) doc._putRecord("blocks", b);
  for (const e of entities) doc._put(e);
  return { doc, bus: new CommandBus(doc) };
}

const near = (a: { x: number; y: number }, x: number, y: number) => {
  expect(a.x).toBeCloseTo(x, 6);
  expect(a.y).toBeCloseTo(y, 6);
};

describe("evaluateInsert placement", () => {
  it("applies translate · rotate · scale · translate(-base)", () => {
    const { doc } = docWith([def("B", [line("l", 1, 0, 3, 0)], { basePoint: { x: 1, y: 0 } })]);
    const out = evaluateInsert(doc, ins("i", "B", 5, 5, { rotation: Math.PI / 2, scale: { x: 2, y: 2 } })) as LineEntity[];
    expect(out).toHaveLength(1);
    near(out[0].a, 5, 5); // the base point lands on the insertion point
    near(out[0].b, 5, 9); // 2 long along local x -> scaled 4, turned to +y
  });

  it("stamps an array along the insert's own rotated axes", () => {
    const { doc } = docWith([def("B", [line("l", 0, 0, 1, 0)])]);
    const out = evaluateInsert(doc, ins("i", "B", 0, 0, { rotation: Math.PI / 2, array: { cols: 2, rows: 2, colSpacing: 10, rowSpacing: 5 } })) as LineEntity[];
    expect(out).toHaveLength(4);
    const starts = out.map((l) => `${l.a.x.toFixed(3)},${l.a.y.toFixed(3)}`).sort();
    // columns step along +y (the rotated x axis), rows along -x
    expect(starts).toEqual(["-5.000,0.000", "-5.000,10.000", "0.000,0.000", "0.000,10.000"]);
    expect(new Set(out.map((e) => e.id)).size).toBe(4);
  });

  it("turns a circle under uneven scale into an ellipse and an arc into an elliptical arc", () => {
    const { doc } = docWith([
      def("B", [
        { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 1 },
        { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2, ccw: true },
      ]),
    ]);
    const out = evaluateInsert(doc, ins("i", "B", 0, 0, { scale: { x: 3, y: 1 } }));
    expect(out.map((e) => e.type)).toEqual(["ellipse", "ellipse"]);
    const bounds = out.map((e) => kindBounds(e)!);
    expect(bounds[0].maxX).toBeCloseTo(3, 4);
    expect(bounds[0].maxY).toBeCloseTo(1, 4);
    // the quarter arc runs from (3,0) to (0,1)
    const runs = kindTessellate(out[1], 0.01)[0];
    near(runs[0], 3, 0);
    near(runs[runs.length - 1], 0, 1);
  });

  it("mirrors an arc with a negative scale", () => {
    const { doc } = docWith([def("B", [{ id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 2, startAngle: 0, endAngle: Math.PI / 2, ccw: true }])]);
    const [a] = evaluateInsert(doc, ins("i", "B", 0, 0, { scale: { x: -1, y: 1 } }));
    const run = kindTessellate(a, 0.01)[0];
    const xs = run.map((p) => p.x);
    expect(Math.max(...xs)).toBeLessThan(1e-6); // reflected into x <= 0
    expect(Math.min(...xs)).toBeCloseTo(-2, 4);
  });

  it("keeps a hatch inside a block, scaled with it", () => {
    const h: Entity = { id: "h", type: "hatch", loops: [loopFromPoints([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }])], paint: { kind: "pattern", name: "ANSI31", scale: 1, angle: 0 }, style: "normal" };
    const { doc } = docWith([def("B", [h])]);
    const [out] = evaluateInsert(doc, ins("i", "B", 10, 0, { scale: { x: 2, y: 2 } }));
    expect(out.type).toBe("hatch");
    const b = kindBounds(out)!;
    expect([b.minX, b.maxX, b.maxY]).toEqual([10, 14, 4]);
    if (out.type === "hatch" && out.paint.kind === "pattern") expect(out.paint.scale).toBe(2);
  });
});

describe("layer 0 and BYBLOCK inheritance", () => {
  it("gives layer-0 content, BYBLOCK colour and BYBLOCK linetype the insert's values", () => {
    const { doc } = docWith([
      def("B", [
        line("a", 0, 0, 1, 0), // no layer = "0"
        line("b", 0, 0, 1, 0, { layer: "0", color: "BYBLOCK", linetype: "BYBLOCK" }),
        line("c", 0, 0, 1, 0, { layer: "keep", color: "#123456" }),
      ]),
    ]);
    const out = evaluateInsert(doc, ins("i", "B", 0, 0, { layer: "walls", color: "#ff0000", linetype: "DASHED" }));
    expect(out.map((e) => e.layer)).toEqual(["walls", "walls", "keep"]);
    expect(out[1].color).toBe("#ff0000");
    expect(out[1].linetype).toBe("DASHED");
    expect(out[2].color).toBe("#123456");
  });
});

describe("nesting and cyclic references", () => {
  it("expands nested inserts through both placements", () => {
    const { doc } = docWith([def("INNER", [line("l", 0, 0, 1, 0)]), def("OUTER", [ins("n", "INNER", 10, 0, { scale: { x: 2, y: 2 } })])]);
    const [l] = evaluateInsert(doc, ins("i", "OUTER", 100, 0)) as LineEntity[];
    near(l.a, 110, 0);
    near(l.b, 112, 0);
  });

  it("terminates on a block that inserts itself, and on a two-block loop (data from a malformed file)", () => {
    const self = def("A", [line("l", 0, 0, 1, 0), ins("n", "A")]);
    const a = def("X", [ins("nx", "Y"), line("lx", 0, 0, 1, 0)]);
    const b = def("Y", [ins("ny", "X"), line("ly", 0, 0, 2, 0)]);
    const { doc } = docWith([self, a, b]);
    expect(evaluateInsert(doc, ins("i", "A"))).toHaveLength(1); // the self-reference is dropped, the line stays
    const xs = evaluateInsert(doc, ins("j", "X"));
    expect(xs.length).toBeGreaterThan(0);
    expect(xs.length).toBeLessThan(10);
    // generic kind code stays finite as well
    withBlocks(doc, () => expect(kindBounds(ins("j", "X"))).not.toBeNull());
  });

  it("stops following nesting past MAX_BLOCK_DEPTH", () => {
    const blocks: BlockDefinition[] = [def("L0", [line("l", 0, 0, 1, 0)])];
    for (let i = 1; i <= 12; i++) blocks.push(def(`L${i}`, [ins("n", `L${i - 1}`)]));
    const { doc } = docWith(blocks);
    expect(evaluateInsert(doc, ins("i", "L3"))).toHaveLength(1);
    expect(evaluateInsert(doc, ins("i", "L12"))).toHaveLength(0);
  });

  it("blockWouldCycle spots direct, indirect and too-deep references", () => {
    const { doc } = docWith([def("A", [line("l", 0, 0, 1, 0)]), def("B", [ins("n", "A")])]);
    expect(blockWouldCycle(doc, "A", [ins("x", "A")])).toBe(true);
    expect(blockWouldCycle(doc, "A", [ins("x", "B")])).toBe(true); // B contains A
    expect(blockWouldCycle(doc, "B", [ins("x", "A")])).toBe(false);
  });

  it("a missing block evaluates to nothing and still has a pickable marker", () => {
    const { doc } = docWith([]);
    expect(evaluateInsert(doc, ins("i", "GONE"))).toEqual([]);
    withBlocks(doc, () => {
      expect(kindHitDistance(ins("i", "GONE", 5, 5), { x: 5.5, y: 5 })).toBeLessThan(1e-9);
    });
  });
});

describe("insert kind", () => {
  const body = def("B", [line("l", 0, 0, 10, 0), { id: "c", type: "circle", center: { x: 5, y: 5 }, radius: 1 }]);

  it("bounds, hit distance and snaps come from the instance's contents", () => {
    const { doc } = docWith([body]);
    const e = ins("i", "B", 100, 100);
    withBlocks(doc, () => {
      const b = kindBounds(e)!;
      expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([100, 110, 100, 106]);
      expect(kindHitDistance(e, { x: 105, y: 100.5 })).toBeCloseTo(0.5, 6);
      const pts = kindSnaps(e).map((s) => `${s.kind}:${s.point.x},${s.point.y}`);
      expect(pts).toContain("endpoint:110,100"); // the block's own line end is snappable
      expect(pts).toContain("center:105,105");
    });
  });

  it("re-reads the definition when the table changes (live edit)", () => {
    const { doc, bus } = docWith([body], [ins("i", "B", 0, 0)]);
    const e = doc.get("i")!;
    expect(kindBounds(e)!.maxX).toBe(10);
    bus.execute({ type: "update-block", name: "B", changes: { entities: [line("l", 0, 0, 50, 0)] } });
    expect(kindBounds(e)!.maxX).toBe(50);
    bus.undo();
    expect(kindBounds(e)!.maxX).toBe(10);
  });

  it("moves, rotates and mirrors as one entity, and keeps id/name/layer", () => {
    const e = ins("i", "B", 10, 0, { name: "I1", layer: "L", color: "#abc" });
    const moved = translated(e, 5, 5);
    expect(moved.insert).toEqual({ x: 15, y: 5 });
    expect([moved.id, moved.name, moved.layer, moved.color]).toEqual(["i", "I1", "L", "#abc"]);
    const turned = rotated(e, { x: 0, y: 0 }, Math.PI / 2);
    near(turned.insert, 0, 10);
    expect(turned.rotation).toBeCloseTo(Math.PI / 2, 9);
    const mirrored = kindTransform(e, [-1, 0, 0, 1, 0, 0]) as InsertEntity; // reflect through the y axis
    near(mirrored.insert, -10, 0);
    // evaluated geometry of the mirrored instance equals the mirrored geometry of the original
    const { doc } = docWith([def("B", [line("l", 0, 0, 4, 1)])]);
    const [orig] = evaluateInsert(doc, e) as LineEntity[];
    const [mir] = evaluateInsert(doc, mirrored) as LineEntity[];
    near(mir.a, -orig.a.x, orig.a.y);
    near(mir.b, -orig.b.x, orig.b.y);
  });

  it("refuses a shearing map instead of drawing it wrong", () => {
    expect(kindTransform(ins("i", "B"), [1, 0, 0.5, 1, 0, 0])).toBeNull();
  });

  it("scales array spacing with a uniform scale", () => {
    const e = ins("i", "B", 0, 0, { array: { cols: 2, rows: 1, colSpacing: 10, rowSpacing: 0 } });
    const s = kindTransform(e, [3, 0, 0, 3, 0, 0]) as InsertEntity;
    expect(s.scale.x).toBeCloseTo(3);
    expect(s.array!.colSpacing).toBeCloseTo(30);
  });
});

describe("B-02 commands", () => {
  const sel = (): Entity[] => [line("a", 0, 0, 10, 0), line("b", 10, 0, 10, 10, { layer: "walls" })];

  it("define-block converts the selection into a block plus one insert at the base point, in one undo step", () => {
    const { doc, bus } = docWith([], sel());
    bus.execute({ type: "define-block", name: "PART", basePoint: { x: 10, y: 0 }, ids: ["a", "b"], insertId: "ins1" });
    expect(doc.all().map((e) => e.id)).toEqual(["ins1"]);
    const d = doc.getRecord("blocks", "PART") as BlockDefinition;
    expect(d.entities.map((e) => e.id)).toEqual(["a", "b"]);
    const [first] = evaluateInsert(doc, doc.get("ins1") as InsertEntity) as LineEntity[];
    near(first.a, 0, 0); // looks exactly as before
    bus.undo();
    expect(doc.all().map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(doc.hasRecord("blocks", "PART")).toBe(false);
  });

  it("define-block retain keeps the originals and adds no insert; delete removes them with no insert", () => {
    const r = docWith([], sel());
    r.bus.execute({ type: "define-block", name: "P", basePoint: { x: 0, y: 0 }, ids: ["a"], insertId: "x", mode: "retain" });
    expect(r.doc.all().map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(r.doc.hasRecord("blocks", "P")).toBe(true);
    const d = docWith([], sel());
    d.bus.execute({ type: "define-block", name: "P", basePoint: { x: 0, y: 0 }, ids: ["a"], insertId: "x", mode: "delete" });
    expect(d.doc.all().map((e) => e.id)).toEqual(["b"]);
  });

  it("define-block is refused for an empty or taken name, an empty selection, or a missing id", () => {
    const { doc, bus } = docWith([def("TAKEN", [line("z", 0, 0, 1, 0)])], sel());
    const before = JSON.stringify(doc.toJSON());
    bus.execute({ type: "define-block", name: "  ", basePoint: { x: 0, y: 0 }, ids: ["a"], insertId: "x" });
    bus.execute({ type: "define-block", name: "TAKEN", basePoint: { x: 0, y: 0 }, ids: ["a"], insertId: "x" });
    bus.execute({ type: "define-block", name: "N", basePoint: { x: 0, y: 0 }, ids: [], insertId: "x" });
    bus.execute({ type: "define-block", name: "N", basePoint: { x: 0, y: 0 }, ids: ["nope"], insertId: "x" });
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  it("define-block can nest an existing insert but never produce a cycle", () => {
    const { doc, bus } = docWith([def("A", [line("z", 0, 0, 1, 0)])], [ins("ia", "A", 0, 0)]);
    bus.execute({ type: "define-block", name: "B", basePoint: { x: 0, y: 0 }, ids: ["ia"], insertId: "ib" });
    expect(doc.hasRecord("blocks", "B")).toBe(true);
    // A may not now contain B (B contains A)
    bus.execute({ type: "update-block", name: "A", changes: { entities: [ins("loop", "B")] } });
    expect((doc.getRecord("blocks", "A") as BlockDefinition).entities.map((e) => e.id)).toEqual(["z"]);
    // or itself
    bus.execute({ type: "update-block", name: "A", changes: { entities: [ins("loop", "A")] } });
    expect((doc.getRecord("blocks", "A") as BlockDefinition).entities.map((e) => e.id)).toEqual(["z"]);
  });

  it("update-block re-renders every instance and undoes to the old body", () => {
    const { doc, bus } = docWith([def("B", [line("l", 0, 0, 1, 0)])], [ins("i1", "B", 0, 0), ins("i2", "B", 0, 10)]);
    bus.execute({ type: "update-block", name: "B", changes: { entities: [line("l", 0, 0, 7, 0)], description: "longer" } });
    for (const id of ["i1", "i2"]) expect(kindBounds(doc.get(id)!)!.maxX).toBe(7);
    expect((doc.getRecord("blocks", "B") as BlockDefinition).description).toBe("longer");
    bus.undo();
    for (const id of ["i1", "i2"]) expect(kindBounds(doc.get(id)!)!.maxX).toBe(1);
  });

  it("rename-block rewrites inserts and nested inserts in one undo step; refuses a taken name", () => {
    const { doc, bus } = docWith([def("A", [line("z", 0, 0, 1, 0)]), def("B", [ins("n", "A")]), def("C", [])], [ins("i", "A"), ins("j", "B")]);
    bus.execute({ type: "rename-block", from: "A", to: "C" }); // taken
    expect(doc.hasRecord("blocks", "A")).toBe(true);
    bus.execute({ type: "rename-block", from: "A", to: "PART" });
    expect((doc.get("i") as InsertEntity).block).toBe("PART");
    expect(((doc.getRecord("blocks", "B") as BlockDefinition).entities[0] as InsertEntity).block).toBe("PART");
    expect(evaluateInsert(doc, doc.get("j") as InsertEntity)).toHaveLength(1);
    bus.undo();
    expect((doc.get("i") as InsertEntity).block).toBe("A");
    expect(((doc.getRecord("blocks", "B") as BlockDefinition).entities[0] as InsertEntity).block).toBe("A");
  });

  it("delete-block refuses while referenced, deletes when free, and purge removes the references", () => {
    const { doc, bus } = docWith([def("A", [line("z", 0, 0, 1, 0)]), def("B", [ins("n", "A")]), def("FREE", [])], [ins("i", "A"), ins("k", "B")]);
    bus.execute({ type: "delete-block", name: "A" });
    expect(doc.hasRecord("blocks", "A")).toBe(true);
    bus.execute({ type: "delete-block", name: "FREE" });
    expect(doc.hasRecord("blocks", "FREE")).toBe(false);
    bus.execute({ type: "delete-block", name: "A", purge: true });
    expect(doc.hasRecord("blocks", "A")).toBe(false);
    expect(doc.has("i")).toBe(false);
    expect((doc.getRecord("blocks", "B") as BlockDefinition).entities).toEqual([]);
    bus.undo();
    expect(doc.has("i")).toBe(true);
    expect((doc.getRecord("blocks", "B") as BlockDefinition).entities).toHaveLength(1);
    expect(unusedBlocks(doc)).toEqual([]);
  });

  it("explode-insert replaces the instance with its geometry (one level, attributes become text) and honours explodable", () => {
    const inner = def("IN", [line("il", 0, 0, 1, 0)]);
    const outer = def("OUT", [line("ol", 0, 0, 2, 0), ins("n", "IN", 5, 0)], { attributeDefs: [{ tag: "NAME", at: { x: 0, y: 1 }, height: 2, rotation: 0, default: "dflt" }] });
    const { doc, bus } = docWith([inner, outer], [ins("i", "OUT", 100, 0, { scale: { x: 2, y: 2 }, attributes: { NAME: "Bob" } })]);
    bus.execute({ type: "explode-insert", id: "i" });
    const ents = doc.all();
    expect(doc.has("i")).toBe(false);
    expect(ents.map((e) => e.type).sort()).toEqual(["insert", "line", "text"]);
    const nested = ents.find((e) => e.type === "insert") as InsertEntity;
    expect(nested.block).toBe("IN");
    near(nested.insert, 110, 0);
    expect(nested.scale.x).toBeCloseTo(2);
    const txt = ents.find((e) => e.type === "text") as Extract<Entity, { type: "text" }>;
    expect(txt.text).toBe("Bob");
    near(txt.at, 100, 2);
    expect(txt.height).toBeCloseTo(4);
    bus.undo();
    expect(doc.all().map((e) => e.id)).toEqual(["i"]);

    const locked = docWith([def("L", [line("z", 0, 0, 1, 0)], { explodable: false })], [ins("i", "L")]);
    locked.bus.execute({ type: "explode-insert", id: "i" });
    expect(locked.doc.has("i")).toBe(true);
    expect(explodeInsert(locked.doc, locked.doc.get("i") as InsertEntity)).toBeNull();
  });

  it("explode flattens a nested insert that cannot stay an insert (sheared by uneven scale + rotation)", () => {
    const inner = def("IN", [{ id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 1 }]);
    const outer = def("OUT", [ins("n", "IN", 0, 0, { rotation: 0.7, scale: { x: 1, y: 1 } })]);
    const { doc, bus } = docWith([inner, outer], [ins("i", "OUT", 0, 0, { scale: { x: 3, y: 1 } })]);
    bus.execute({ type: "explode-insert", id: "i" });
    expect(doc.all().map((e) => e.type)).toEqual(["ellipse"]);
  });
});

describe("persistence and code", () => {
  it("blocks and inserts round-trip through .sketchor JSON", () => {
    const { doc } = docWith([def("B", [line("l", 0, 0, 1, 0)], { description: "d" })], [ins("i", "B", 3, 4, { rotation: 1, attributes: { T: "v" } })]);
    const back = SketchDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(back.get("i")).toEqual(doc.get("i"));
    expect(back.getRecord("blocks", "B")).toEqual(doc.getRecord("blocks", "B"));
    expect(evaluateInsert(back, back.get("i") as InsertEntity)).toHaveLength(1);
  });

  it("sketch code round-trips an insert and an edit keeps attributes, layer and colour", () => {
    const { doc } = docWith([def("My Block", [line("l", 0, 0, 1, 0)])], [ins("i", "My Block", 3, 4, { name: "I1", rotation: Math.PI / 2, scale: { x: 2, y: 3 }, layer: "walls", color: "#f00", attributes: { T: "v" }, array: { cols: 3, rows: 2, colSpacing: 5, rowSpacing: 6 } })]);
    const code = toCode(doc);
    expect(code).toContain('insert I1 block "My Block" at (3, 4) scale 2 3 rot 90 array 3x2 spacing 5 6');
    const { entities, errors } = parseCode(code);
    expect(errors).toEqual([]);
    expect(diffToCommands(doc, entities)).toEqual([]); // nothing changed
    const edited = parseCode(code.replace("at (3, 4)", "at (30, 4)"));
    const cmds = diffToCommands(doc, edited.entities);
    expect(cmds).toHaveLength(1);
    const upd = (cmds[0] as { entity: InsertEntity }).entity;
    expect(upd.id).toBe("i");
    expect(upd.insert).toEqual({ x: 30, y: 4 });
    expect([upd.layer, upd.color, upd.attributes, upd.array?.cols]).toEqual(["walls", "#f00", { T: "v" }, 3]);
  });

  it("rejects malformed insert lines without throwing", () => {
    for (const bad of ['insert I1 block "" at (0, 0)', "insert I1 block B at (0, 0)", 'insert I1 block "B" at (0, 0) scale 0', 'insert I1 block "B" at (0, 0) array 0x2 spacing 1 1', 'insert I1 block "B"']) {
      expect(parseCode(bad).errors.length).toBe(1);
    }
  });

  it("copy/paste carries the referenced block definitions into another drawing, without redefining existing ones", () => {
    const src = docWith([def("IN", [line("l", 0, 0, 1, 0)]), def("OUT", [ins("n", "IN", 1, 0)])], [ins("i", "OUT", 0, 0)]);
    const text = serializeSelection(src.doc, ["i"]);
    const payload = parseClipboard(text)!;
    expect(payload.blocks!.map((b) => b.name).sort()).toEqual(["IN", "OUT"]);
    const dest = docWith([def("IN", [line("other", 0, 0, 99, 0)])]);
    const { commands } = pasteCommands(payload, { x: 0, y: 0 }, dest.doc);
    dest.bus.execute({ type: "batch", commands });
    expect(dest.doc.hasRecord("blocks", "OUT")).toBe(true);
    expect(((dest.doc.getRecord("blocks", "IN") as BlockDefinition).entities[0] as LineEntity).id).toBe("other");
    expect(dest.doc.all()).toHaveLength(1);
  });

  it("flattenInserts hands exporters plain geometry", () => {
    const { doc } = docWith([def("B", [line("l", 0, 0, 1, 0)])], [ins("i", "B", 5, 0), line("keep", 0, 0, 1, 1)]);
    const flat = flattenInserts(doc, doc.all());
    expect(flat.map((e) => e.type)).toEqual(["line", "line"]);
  });
});
