/**
 * Why this matters: a hatch is a new entity kind whose boundary can be any mix
 * of lines, arcs, ellipses and splines. A hatch that loses its boundary on a
 * move/rotate/code edit, or whose island rule disagrees with what is drawn,
 * silently ruins a drawing — so the kind's transform, hit test, sketch code
 * and persistence are pinned here.
 */
import { describe, expect, it } from "vitest";
import { SketchDocument } from "../document";
import type { HatchEntity } from "../entities";
import { rotated, transformed, translated } from "../entities";
import { entitiesToDxf2018 } from "../dxfw";
import { parseDxf } from "../dxf";
import { kindBounds, kindHitDistance, kindTessellate, kindTransform } from "../kinds/registry";
import "../kinds/builtin";
import { diffToCommands, parseCode, toCode } from "../sketchtext";
import { hatchContains, hatchPolygons, loopFromCircle, loopFromPoints, loopFromPolyline, loopPolygon, polygonArea } from "./loops";

const square = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

const hatch = (over: Partial<HatchEntity> = {}): HatchEntity => ({
  id: "h",
  type: "hatch",
  name: "H1",
  layer: "walls",
  color: "#0f0",
  loops: [loopFromPoints(square(0, 0, 10))],
  paint: { kind: "pattern", name: "ANSI31", scale: 2, angle: 15, origin: { x: 1, y: 1 } },
  style: "normal",
  ...over,
});

describe("hatch loops", () => {
  it("joins edges stored in either direction into one polygon", () => {
    const loop = {
      edges: [
        { type: "line" as const, a: { x: 10, y: 0 }, b: { x: 0, y: 0 } }, // backwards
        { type: "line" as const, a: { x: 10, y: 0 }, b: { x: 10, y: 10 } },
        { type: "line" as const, a: { x: 0, y: 10 }, b: { x: 10, y: 10 } }, // backwards
        { type: "line" as const, a: { x: 0, y: 10 }, b: { x: 0, y: 0 } },
      ],
    };
    const poly = loopPolygon(loop);
    expect(poly).toHaveLength(4);
    expect(Math.abs(polygonArea(poly))).toBeCloseTo(100, 9);
  });

  it("a circle loop tessellates to a polygon of about pi r^2, inside the tolerance", () => {
    const poly = loopPolygon(loopFromCircle({ x: 5, y: 5 }, 10), 0.01);
    expect(Math.abs(polygonArea(poly))).toBeGreaterThan(Math.PI * 100 * 0.995);
    expect(Math.abs(polygonArea(poly))).toBeLessThan(Math.PI * 100);
  });

  it("a bulged polyline becomes line and arc edges", () => {
    const loop = loopFromPolyline({ points: square(0, 0, 10), bulges: [1, 0, 0, 0], closed: true });
    expect(loop.edges.map((e) => e.type)).toEqual(["arc", "line", "line", "line"]);
    expect(Math.abs(polygonArea(loopPolygon(loop)))).toBeGreaterThan(100);
  });

  it("an empty or degenerate loop yields no polygon", () => {
    expect(loopPolygon({ edges: [] })).toEqual([]);
    expect(hatchPolygons(hatch({ loops: [{ edges: [] }, loopFromPoints([{ x: 0, y: 0 }, { x: 1, y: 0 }])] }))).toEqual([]);
  });
});

describe("hatch kind", () => {
  const island = hatch({ loops: [loopFromPoints(square(0, 0, 10)), loopFromPoints(square(3, 3, 4)), loopFromPoints(square(4, 4, 2))] });

  it("the island styles paint different rings", () => {
    const inRing1 = { x: 1, y: 1 };
    const inRing2 = { x: 3.5, y: 3.5 };
    const inRing3 = { x: 5, y: 5 };
    const outside = { x: 20, y: 20 };
    const probe = (style: HatchEntity["style"]) => [inRing1, inRing2, inRing3, outside].map((p) => hatchContains({ ...island, style }, p));
    expect(probe("normal")).toEqual([true, false, true, false]);
    expect(probe("outer")).toEqual([true, false, false, false]);
    expect(probe("ignore")).toEqual([true, true, true, false]);
  });

  it("hit distance is 0 on painted area, positive in an island, and distance to the edge outside", () => {
    expect(kindHitDistance(island, { x: 1, y: 1 })).toBe(0);
    expect(kindHitDistance(island, { x: 3.5, y: 3.5 })).toBeCloseTo(0.5, 6);
    expect(kindHitDistance(island, { x: 13, y: 5 })).toBeCloseTo(3, 6);
  });

  it("bounds contain the tessellation and tessellation is closed runs", () => {
    const h = hatch({ loops: [loopFromCircle({ x: 0, y: 0 }, 5)] });
    const b = kindBounds(h)!;
    for (const run of kindTessellate(h, 0.01)) {
      expect(run[0]).toEqual(run[run.length - 1]);
      for (const p of run) {
        expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-9);
        expect(p.x).toBeLessThanOrEqual(b.maxX + 1e-9);
      }
    }
    expect(b.maxX - b.minX).toBeCloseTo(10, 1);
  });

  it("translate/rotate/transform keep id, name, layer and colour and move boundary and pattern origin", () => {
    const t = translated(hatch(), 5, -3);
    expect(t).toMatchObject({ id: "h", name: "H1", layer: "walls", color: "#0f0" });
    expect(t.paint).toMatchObject({ origin: { x: 6, y: -2 } });
    expect(kindBounds(t)).toMatchObject({ minX: 5, minY: -3, maxX: 15, maxY: 7 });
    const r = rotated(hatch(), { x: 0, y: 0 }, Math.PI / 2);
    expect(r).toMatchObject({ id: "h", name: "H1", layer: "walls", color: "#0f0" });
    expect((r.paint as { angle: number }).angle).toBeCloseTo(105, 6);
    const s = transformed(hatch(), { x: 0, y: 0 }, 0, 0, 0, 3);
    expect((s.paint as { scale: number }).scale).toBeCloseTo(6, 9);
    expect(kindBounds(s)).toMatchObject({ maxX: 30, maxY: 30 });
  });

  it("a mirror reverses the pattern angle; a non-uniform scale is refused for a pattern but kept for solid straight loops", () => {
    const m = kindTransform(hatch({ paint: { kind: "pattern", name: "X", scale: 1, angle: 30 } }), [-1, 0, 0, 1, 0, 0]) as HatchEntity;
    expect((m.paint as { angle: number }).angle).toBeCloseTo(150, 6);
    expect(kindTransform(hatch(), [2, 0, 0, 1, 0, 0])).toBeNull();
    const solid = kindTransform(hatch({ paint: { kind: "solid", color: "#abc" } }), [2, 0, 0, 1, 0, 0]) as HatchEntity;
    expect(kindBounds(solid)).toMatchObject({ maxX: 20, maxY: 10 });
  });

  it("a boundary arc follows a rigid transform", () => {
    const h = hatch({ loops: [loopFromCircle({ x: 0, y: 0 }, 5)] });
    const t = kindTransform(h, [1, 0, 0, 1, 10, 0]) as HatchEntity;
    expect(t.loops[0].edges[0]).toMatchObject({ type: "arc", center: { x: 10, y: 0 }, radius: 5 });
  });
});

describe("hatch persistence", () => {
  const docWith = (...e: HatchEntity[]) => {
    const doc = new SketchDocument();
    for (const x of e) doc._put(x);
    return doc;
  };

  it("sketch code round-trips and an edit keeps id, colour and the pattern's own line families", () => {
    const def = [{ angle: 45, origin: { x: 0, y: 0 }, offset: { x: 0, y: 3 }, dashes: [] }];
    const h = hatch({ paint: { kind: "pattern", name: "ANSI31", scale: 2, angle: 15, def }, associative: true, sources: ["a"] });
    const doc = docWith(h);
    const code = toCode(doc);
    expect(code).toContain("hatch H1 pattern ANSI31 scale 2 angle 15 boundary (0, 0) (10, 0) (10, 10) (0, 10)");
    const parsed = parseCode(code);
    expect(parsed.errors).toEqual([]);
    expect(diffToCommands(doc, parsed.entities)).toEqual([]);
    const cmds = diffToCommands(doc, parseCode(code.replace("scale 2", "scale 4")).entities);
    expect(cmds).toHaveLength(1);
    const u = (cmds[0] as { entity: HatchEntity }).entity;
    expect(u).toMatchObject({ id: "h", color: "#0f0", associative: true, sources: ["a"], layer: "walls" });
    expect(u.paint).toMatchObject({ scale: 4, def });
  });

  it("a curved boundary is written as a loop count and survives a paint edit", () => {
    const h = hatch({ loops: [loopFromCircle({ x: 0, y: 0 }, 5)], style: "outer" });
    const doc = docWith(h);
    const code = toCode(doc);
    expect(code).toContain("style outer loops 1");
    const cmds = diffToCommands(doc, parseCode(code.replace("angle 15", "angle 90")).entities);
    expect((cmds[0] as { entity: HatchEntity }).entity.loops).toEqual(h.loops);
  });

  it("code can create a new polygon hatch, solid and gradient forms parse, and bad input is a clear error", () => {
    const { entities, errors } = parseCode("hatch H9 solid #ff8800 boundary (0, 0) (4, 0) (4, 4) | (1, 1) (2, 1) (2, 2)\nhatch G1 gradient LINEAR #f00 #00f angle 30 boundary (0, 0) (1, 0) (1, 1)");
    expect(errors).toEqual([]);
    expect(entities).toHaveLength(2);
    const doc = new SketchDocument();
    const cmds = diffToCommands(doc, entities);
    expect(cmds).toHaveLength(2);
    expect((cmds[0] as { entity: HatchEntity }).entity.loops).toHaveLength(2);
    expect(parseCode("hatch H1 pattern").errors[0].message).toMatch(/pattern/);
    expect(parseCode("hatch H1 pattern X scale -1 angle 0 boundary (0,0) (1,0) (1,1)").errors[0].message).toMatch(/scale/);
    expect(parseCode("hatch H1 pattern X boundary (0,0) (1,0)").errors[0].message).toMatch(/3 points/);
    expect(parseCode("hatch H1 wavy").errors[0].message).toMatch(/pattern/);
    // `loops N` with nothing to attach to cannot create anything.
    expect(diffToCommands(new SketchDocument(), parseCode("hatch H1 pattern X scale 1 angle 0 loops 2").entities)).toEqual([]);
  });

  it("a document JSON round trip carries the hatch as-is", () => {
    const h = hatch({ backgroundColor: "#eee", transparency: 0.25 });
    expect(SketchDocument.fromJSON(docWith(h).toJSON()).get("h")).toEqual(h);
  });

  it("DXF 2018 export writes a real HATCH that reads back with the same boundary extent (H-09)", () => {
    const text = entitiesToDxf2018([hatch()]);
    expect(text).toContain("AcDbHatch");
    const back = parseDxf(text).entities;
    expect(back.length).toBe(1);
    expect(back[0].type).toBe("hatch");
    const b = kindBounds(back[0])!;
    expect(b.minX).toBeCloseTo(0, 6);
    expect(b.maxX).toBeCloseTo(10, 6);
  });
});
