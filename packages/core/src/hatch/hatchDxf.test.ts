/**
 * Why this matters: HATCH is how every other CAD exchanges fills. A hatch that
 * comes back with a different pattern spacing, a lost island or a wrong colour
 * is silent damage to a drawing someone will print. These round-trip Sketchor's
 * own writer through its own reader (ink, area, island count, paint) and pin the
 * reader against a hand-written AutoCAD-style record, hostile input, and R12.
 */
import { describe, expect, it } from "vitest";
import { parseDxf } from "../dxf";
import { entitiesToDxf } from "../dxfExport";
import { entitiesToDxf2018 } from "../dxfw";
import type { Entity, HatchEntity } from "../entities";
import "../kinds/builtin";
import { hatchFill } from "./fillLines";
import "./library";
import { loopFromCircle, loopFromPoints, hatchPolygons, polygonArea } from "./loops";
import { parseDxfHatch, type DxfPair } from "./hatchDxf";

const sq = (x: number, y: number, s: number) => loopFromPoints([{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }]);
const base = (over: Partial<HatchEntity> = {}): HatchEntity => ({
  id: "h",
  type: "hatch",
  layer: "walls",
  loops: [sq(0, 0, 40), loopFromCircle({ x: 20, y: 20 }, 8)],
  paint: { kind: "pattern", name: "ANSI31", scale: 1.5, angle: 20 },
  style: "normal",
  ...over,
});

const ink = (h: HatchEntity): number => {
  const f = hatchFill(h);
  let t = 0;
  for (let i = 0; i < f.segments.length; i += 4) t += Math.hypot(f.segments[i + 2] - f.segments[i], f.segments[i + 3] - f.segments[i + 1]);
  return t;
};
const area = (h: HatchEntity): number => hatchPolygons(h, 0.005).reduce((s, p, i) => s + (i === 0 ? 1 : -1) * Math.abs(polygonArea(p)), 0);

function roundTrip(h: HatchEntity): HatchEntity {
  const text = entitiesToDxf2018([h], { insUnits: 4 });
  const r = parseDxf(text);
  const out = r.entities.find((e): e is HatchEntity => e.type === "hatch");
  if (!out) throw new Error("no hatch came back: " + r.warnings.join("; "));
  return out;
}

describe("HATCH in AC1032", () => {
  it("a pattern hatch with an island keeps its ink, area, paint and layer", () => {
    const h = base();
    const back = roundTrip(h);
    expect(back.layer).toBe("walls");
    expect(back.loops).toHaveLength(2);
    expect(area(back)).toBeCloseTo(area(h), 2);
    expect(ink(back)).toBeCloseTo(ink(h), 1);
    expect(back.paint).toMatchObject({ kind: "pattern", name: "ANSI31", scale: 1.5, angle: 20 });
    expect(back.style).toBe("normal");
  });

  it("angle, scale, origin and a dashed pattern survive (the definition lines carry them)", () => {
    const h = base({ paint: { kind: "pattern", name: "ACAD_ISO02W100", scale: 2, angle: 37, origin: { x: 3, y: 4 } }, style: "outer" });
    const back = roundTrip(h);
    expect(back.style).toBe("outer");
    expect(ink(back)).toBeCloseTo(ink(h), 1);
    expect(ink(back)).toBeGreaterThan(0);
  });

  it("a pattern Sketchor does not have still renders from the written definition", () => {
    const h = base({ paint: { kind: "pattern", name: "ONLY_IN_FILE", scale: 1, angle: 0, def: [{ angle: 45, origin: { x: 0, y: 0 }, offset: { x: 0, y: 5 }, dashes: [] }] } });
    const back = roundTrip(h);
    expect(back.paint.kind === "pattern" && back.paint.def).toBeTruthy();
    expect(ink(back)).toBeCloseTo(ink(h), 1);
  });

  it("solid keeps its colour (entity colour in DXF), gradient keeps kind, colours and angle", () => {
    const solid = roundTrip(base({ paint: { kind: "solid", color: "#336699" } }));
    expect(solid.paint).toEqual({ kind: "solid", color: "#336699" });
    const grad = roundTrip(base({ paint: { kind: "gradient", name: "CYLINDER", colors: ["#ff0000", "#0000ff"], angle: 30 } }));
    expect(grad.paint).toMatchObject({ kind: "gradient", name: "CYLINDER", colors: ["#ff0000", "#0000ff"] });
    expect((grad.paint as { angle: number }).angle).toBeCloseTo(30, 4);
    const tint = roundTrip(base({ paint: { kind: "gradient", name: "LINEAR", colors: ["#00ff00"], angle: 0 } }));
    expect((tint.paint as { colors: string[] }).colors).toHaveLength(1);
  });

  it("transparency round-trips; arcs, ellipses and splines in the boundary stay exact", () => {
    const h = base({
      transparency: 0.5,
      loops: [
        {
          edges: [
            { type: "line", a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
            { type: "arc", center: { x: 20, y: 10 }, radius: 10, startAngle: -Math.PI / 2, endAngle: Math.PI / 2, ccw: true },
            { type: "line", a: { x: 20, y: 20 }, b: { x: 0, y: 20 } },
            { type: "spline", degree: 2, controlPoints: [{ x: 0, y: 20 }, { x: -5, y: 10 }, { x: 0, y: 0 }], knots: [0, 0, 0, 1, 1, 1] },
          ],
        },
        { edges: [{ type: "ellipse", center: { x: 12, y: 10 }, majorAxis: { x: 4, y: 0 }, ratio: 0.5, start: 0, end: Math.PI * 2 }] },
      ],
    });
    const back = roundTrip(h);
    expect(back.transparency).toBeCloseTo(0.5, 2);
    expect(back.loops[0].edges.map((e) => e.type)).toEqual(["line", "arc", "line", "spline"]);
    expect(back.loops[1].edges[0].type).toBe("ellipse");
    expect(area(back)).toBeCloseTo(area(h), 1);
  });

  it("works inside a scaled unit (inches) — pattern scale follows the drawing", () => {
    const h = base();
    const text = entitiesToDxf2018([h], { insUnits: 1, scale: 1 / 25.4 });
    const back = parseDxf(text).entities.find((e): e is HatchEntity => e.type === "hatch")!;
    expect(area(back)).toBeCloseTo(area(h), 1);
    expect(ink(back)).toBeCloseTo(ink(h), 0);
  });
});

describe("reading foreign HATCH records", () => {
  const rec = (pairs: [number, string | number][]): DxfPair[] => pairs.map(([code, value]) => ({ code, value: String(value) }));

  it("a polyline-boundary hatch with a bulge, as AutoCAD writes it", () => {
    const p = parseDxfHatch(
      rec([
        [100, "AcDbHatch"], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, "ANSI31"], [70, 0], [71, 0], [91, 1],
        [92, 7], [72, 1], [73, 1], [93, 4], [10, 0], [20, 0], [42, 0.5], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10], [97, 0],
        [75, 0], [76, 1], [52, 0], [41, 1], [77, 0], [78, 1], [53, 45], [43, 0], [44, 0], [45, -1.5], [46, 1.5], [79, 0], [47, 1], [98, 1], [10, 5], [20, 5],
      ]),
    )!;
    expect(p.loops).toHaveLength(1);
    expect(p.loops[0].edges.some((e) => e.type === "arc")).toBe(true);
    expect(p.paint.kind === "pattern" && p.paint.def?.[0].offset.y).toBeCloseTo(Math.hypot(1.5, 1.5), 9);
    expect(p.paint.kind === "pattern" && p.paint.def?.[0].offset.x).toBeCloseTo(0, 9);
  });

  it("an associative hatch resolves its source handles to entity ids, only when all of them exist", () => {
    const dxf = (handles: string[]) =>
      ["0", "SECTION", "2", "ENTITIES",
        "0", "LINE", "5", "A1", "8", "0", "10", "0", "20", "0", "11", "10", "21", "0",
        "0", "LINE", "5", "A2", "8", "0", "10", "10", "20", "0", "11", "10", "21", "10",
        "0", "LINE", "5", "A3", "8", "0", "10", "10", "20", "10", "11", "0", "21", "0",
        "0", "HATCH", "5", "B1", "8", "0", "100", "AcDbHatch", "2", "SOLID", "70", "1", "71", "1", "91", "1",
        "92", "1", "93", "3",
        "72", "1", "10", "0", "20", "0", "11", "10", "21", "0",
        "72", "1", "10", "10", "20", "0", "11", "10", "21", "10",
        "72", "1", "10", "10", "20", "10", "11", "0", "21", "0",
        "97", String(handles.length), ...handles.flatMap((h) => ["330", h]),
        "75", "0", "76", "1", "47", "1", "98", "0",
        "0", "ENDSEC", "0", "EOF"].join("\n");
    const ok = parseDxf(dxf(["A1", "A2", "A3"])).entities.find((e): e is HatchEntity => e.type === "hatch")!;
    expect(ok.associative).toBe(true);
    expect(ok.sources).toHaveLength(3);
    const bad = parseDxf(dxf(["A1", "ZZ"])).entities.find((e): e is HatchEntity => e.type === "hatch")!;
    expect(bad.associative).toBeUndefined();
  });

  it("truncated or malformed records never throw", () => {
    expect(parseDxfHatch([])).toBeNull();
    expect(parseDxfHatch(rec([[91, 5], [92, 0], [93, 99999999]]))).toBeNull();
    expect(parseDxfHatch(rec([[91, 1], [92, 0], [93, 1], [72, 4], [94, 3], [95, 7]]))).toBeNull();
    expect(() => parseDxfHatch(rec([[91, "x"], [92, "y"]]))).not.toThrow();
    const text = entitiesToDxf2018([base()], { insUnits: 4 });
    for (const cut of [0.5, 0.7, 0.9]) expect(() => parseDxf(text.slice(0, Math.floor(text.length * cut)))).not.toThrow();
  });
});

describe("HATCH in R12", () => {
  it("a pattern is exploded to LINEs and no HATCH record is written", () => {
    const text = entitiesToDxf([base()], 4);
    expect(text).not.toContain("\nHATCH\n");
    const back = parseDxf(text).entities;
    expect(back.filter((e: Entity) => e.type === "line").length).toBe(hatchFill(base()).segments.length / 4);
  });
});
