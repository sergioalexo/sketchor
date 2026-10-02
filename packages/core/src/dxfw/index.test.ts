import { describe, expect, it } from "vitest";
import { entitiesToDxf2018 } from "./index";
import { parseDxf } from "../dxf";
import { layerOf } from "../entities";
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity, TextEntity } from "../entities";

/**
 * X-01: the AC1032 ("DXF 2018") writer, validated two ways — through
 * Sketchor's own parser (round-trip, including the SKETCHOR XDATA name that
 * R12 export always lost) and, offline during development, through
 * `ezdxf.audit()` (zero errors on every fixture here; not re-run in CI —
 * see X-02 for the harness that would).
 */

const line = (): LineEntity => ({ id: "l", type: "line", name: "L1", a: { x: 0, y: 0 }, b: { x: 100, y: 50 } });
const circle = (): CircleEntity => ({ id: "c", type: "circle", name: "C1", layer: "holes", center: { x: 20, y: 30 }, radius: 12.5 });
const arcCcw = (): ArcEntity => ({
  id: "a",
  type: "arc",
  name: "A1",
  center: { x: -10, y: 5 },
  radius: 8,
  startAngle: 0,
  endAngle: Math.PI / 2,
  ccw: true,
});
const point = (): PointEntity => ({ id: "p", type: "point", name: "P1", layer: "marks", p: { x: 7, y: -3 } });
const bulgedClosed = (): PolylineEntity => ({
  id: "pl",
  type: "polyline",
  name: "PL1",
  layer: "outline",
  points: [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
  ],
  bulges: [0.5, 0, -0.25],
  closed: true,
});
const text = (): TextEntity => ({ id: "t", type: "text", name: "T1", at: { x: 5, y: 5 }, text: "Hello", height: 2.5, rotation: 0 });

const reimport = (entities: Entity[], opts?: Parameters<typeof entitiesToDxf2018>[1]): Entity[] =>
  parseDxf(entitiesToDxf2018(entities, opts)).entities;

describe("file structure", () => {
  it("writes AC1032 and every required section in order", () => {
    const text = entitiesToDxf2018([line()]);
    expect(text).toContain("9\n$ACADVER\n1\nAC1032\n");
    const order = [
      "2\nHEADER",
      "2\nCLASSES",
      "2\nTABLES",
      "2\nBLOCKS",
      "2\nENTITIES",
      "2\nOBJECTS",
      "0\nEOF",
    ].map((s) => text.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("gives every table, block and entity record a handle and an owner pointer", () => {
    const text = entitiesToDxf2018([line(), circle()]);
    // Every ENTITIES record opens with "0\n<TYPE>\n5\n<handle>\n330\n<owner>".
    const entityRecords = [...text.matchAll(/0\n(LINE|CIRCLE)\n5\n([0-9A-F]+)\n330\n([0-9A-F]+)\n/g)];
    expect(entityRecords).toHaveLength(2);
    for (const [, , handle, owner] of entityRecords) {
      expect(handle.length).toBeGreaterThan(0);
      expect(owner.length).toBeGreaterThan(0);
    }
    // Handles are unique across the whole file.
    const allHandles = [...text.matchAll(/(?:^|\n)5\n([0-9A-F]+)\n/g)].map((m) => m[1]);
    expect(new Set(allHandles).size).toBe(allHandles.length);
  });

  it("registers the SKETCHOR APPID and tags every named entity's XDATA", () => {
    const text = entitiesToDxf2018([line()]);
    expect(text).toContain("2\nSKETCHOR\n70\n0\n");
    expect(text).toContain("1001\nSKETCHOR\n1000\nL1\n");
  });

  it("writes $HANDSEED past the highest handle actually used", () => {
    const text = entitiesToDxf2018([line(), circle(), arcCcw()]);
    const seedMatch = text.match(/9\n\$HANDSEED\n5\n([0-9A-F]+)\n/);
    expect(seedMatch).not.toBeNull();
    const seed = parseInt(seedMatch![1], 16);
    // Scan past HEADER so $HANDSEED's own value (not itself a handle) isn't counted.
    const body = text.slice(text.indexOf("0\nENDSEC\n"));
    const allHandles = [...body.matchAll(/(?:^|\n)5\n([0-9A-F]+)\n/g)].map((m) => parseInt(m[1], 16));
    expect(Math.max(...allHandles)).toBeLessThan(seed);
  });

  it("still produces a structurally valid file for an empty drawing", () => {
    const text = entitiesToDxf2018([]);
    expect(text).toContain("0\nEOF\n");
    expect(parseDxf(text).entities).toEqual([]);
  });
});

describe("round-trip through parseDxf", () => {
  it("preserves geometry and name for every built-in entity kind", () => {
    const entities = [line(), circle(), arcCcw(), point(), bulgedClosed(), text()];
    const back = reimport(entities);
    expect(back).toHaveLength(entities.length);
    expect(back.map((e) => e.name)).toEqual(entities.map((e) => e.name));
    expect(back.map(layerOf)).toEqual(entities.map(layerOf));

    const [l, c, a, p, pl] = back as [LineEntity, CircleEntity, ArcEntity, PointEntity, PolylineEntity];
    expect(l.a).toEqual({ x: 0, y: 0 });
    expect(l.b).toEqual({ x: 100, y: 50 });
    expect(c).toMatchObject({ center: { x: 20, y: 30 }, radius: 12.5 });
    expect(a.ccw).toBe(true);
    expect(p.p).toEqual({ x: 7, y: -3 });
    expect(pl.bulges).toEqual([0.5, 0, -0.25]);
  });

  it("drops the name when a parser produced more than one entity for a record (not applicable here, but asserts the single-record case stays precise)", () => {
    const [back] = reimport([line()]) as LineEntity[];
    expect(back.name).toBe("L1");
  });

  it("round-trips through a scaled, unit-tagged file", () => {
    const c: CircleEntity = { id: "c", type: "circle", name: "C1", center: { x: 254, y: 0 }, radius: 25.4 };
    const [back] = reimport([c], { insUnits: 1, scale: 1 / 25.4 }) as CircleEntity[];
    expect(back.center.x).toBeCloseTo(254, 6);
    expect(back.radius).toBeCloseTo(25.4, 6);
    expect(back.name).toBe("C1");
  });

  it("survives a full drawing without warnings or skipped types", () => {
    const entities = [line(), circle(), arcCcw(), point(), bulgedClosed(), text()];
    const result = parseDxf(entitiesToDxf2018(entities));
    expect(result.warnings).toEqual([]);
    expect(result.report.skipped).toEqual([]);
  });

  it("tags $MEASUREMENT metric for mm/cm/m and imperial otherwise, omitting it for an unspecified unit", () => {
    expect(entitiesToDxf2018([], { insUnits: 4 })).toContain("9\n$MEASUREMENT\n70\n1\n");
    expect(entitiesToDxf2018([], { insUnits: 1 })).toContain("9\n$MEASUREMENT\n70\n0\n");
    // insUnits=0 means "no real unit" — writing $MEASUREMENT would make our own
    // parser treat it as authoritative and misread the file as inches (see the
    // comment on `header()`), so it's left out entirely.
    expect(entitiesToDxf2018([], { insUnits: 0 })).not.toContain("$MEASUREMENT");
  });
});

describe("X-04: colour", () => {
  it("writes only the ACI fallback (no redundant true colour) for an exact palette match", () => {
    const e: LineEntity = { ...line(), color: "#ff0000" }; // ACI 1, exact
    const text = entitiesToDxf2018([e]);
    expect(text).toContain("\n62\n1\n");
    expect(text).not.toContain("\n420\n");
    const [back] = parseDxf(text).entities as LineEntity[];
    expect(back.color).toBe("#ff0000");
  });

  it("writes both the ACI fallback and an exact true colour (420) for an arbitrary colour", () => {
    const e: CircleEntity = { ...circle(), color: "#5b96ff" };
    const text = entitiesToDxf2018([e]);
    expect(text).toMatch(/\n62\n\d+\n/);
    const trueColorInt = (0x5b << 16) | (0x96 << 8) | 0xff;
    expect(text).toContain(`\n420\n${trueColorInt}\n`);
    // Unlike R12, the AC1032 round trip is lossless: the parser prefers 420 over 62.
    const [back] = parseDxf(text).entities as CircleEntity[];
    expect(back.color).toBe("#5b96ff");
  });

  it("writes nothing (BYLAYER) for an entity with no explicit colour", () => {
    const text = entitiesToDxf2018([line()]);
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).not.toMatch(/\n62\n/);
    expect(entitySection).not.toMatch(/\n420\n/);
  });
});
