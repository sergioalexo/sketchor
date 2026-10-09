import { describe, expect, it } from "vitest";
import { entitiesToDxf2018 } from "./index";
import { parseDxf } from "../dxf";
import type { CircleEntity, Entity, LineEntity } from "../entities";
import type { Group } from "../groups";
import type { Constraint } from "../constraints";
import { encodeDocData, decodeDocData, parseEntityXdata } from "../sketchorData";

/**
 * X-05 / X-08: Sketchor -> DXF -> Sketchor must lose nothing Sketchor itself
 * put there (ids, names, construction flag, fill, groups incl. nesting,
 * constraints, params) and a foreign file's plain GROUP objects must still
 * become groups. If this regresses, a saved drawing silently loses its
 * constraints or grouping on reopen.
 */

const line = (id: string, extra: Partial<LineEntity> = {}): LineEntity => ({ id, type: "line", layer: "0", a: { x: 0, y: 0 }, b: { x: 10, y: 5 }, ...extra });
const circ = (id: string, extra: Partial<CircleEntity> = {}): CircleEntity => ({ id, type: "circle", layer: "0", center: { x: 5, y: 5 }, radius: 3, ...extra });

const sortById = (es: Entity[]) => [...es].sort((a, b) => a.id.localeCompare(b.id));

describe("SKETCHOR XDATA / record round trip", () => {
  const entities: Entity[] = [
    line("e1", { name: "L1", construction: true, color: "#ff8800" }),
    circ("e2", { name: "C1", fill: "#336699", layer: "holes" }),
    line("e3"),
    line("e4", { name: "Дві" }),
  ];
  const groups: Group[] = [
    { id: "gA", name: "Inner", members: ["e1", "e2"], parent: "gB" },
    { id: "gB", name: "Outer", members: ["gA", "e3"] },
  ];
  const constraints: Constraint[] = [
    { id: "k1", type: "parallel", a: "e1", b: "e3" },
    { id: "k2", type: "radius", entityId: "e2", value: 3 },
  ];
  const params = [{ name: "width", value: 12.5, expr: "w*2" }];
  const text = entitiesToDxf2018(entities, { groups, constraints, params });
  const back = parseDxf(text);

  it("restores ids, names, construction, fill (lossless entity records)", () => {
    expect(sortById(back.entities)).toEqual(sortById(entities));
  });

  it("restores groups exactly (ids, nesting), constraints and params", () => {
    expect(back.groups).toEqual(groups);
    expect(back.constraints).toEqual(constraints);
    expect(back.params).toEqual(params);
  });

  it("writes real DXF GROUP objects (flattened, uniquely named) in ACAD_GROUP", () => {
    expect(text).toContain("0\nGROUP\n");
    expect(text).toContain("3\nInner\n350\n");
    expect(text).toContain("3\nOuter\n350\n");
    const outer = text.split("0\nGROUP\n")[2];
    expect((outer.match(/340\n/g) ?? []).length).toBe(3); // e1, e2, e3 flattened
  });

  it("keeps the untagged first XDATA string = name, for older readers", () => {
    expect(text).toContain("1001\nSKETCHOR\n1000\nL1\n1000\nid=e1\n");
  });

  it("a duplicated id (entity copied in another CAD app) keeps a fresh id instead of colliding", () => {
    const dup = text.replace("1000\nid=e3\n", "1000\nid=e1\n");
    const ids = parseDxf(dup).entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drops groups that name no importable entity, and survives a corrupt record", () => {
    const broken = text.replace(/1\n\{"v":1/, "1\n{broken");
    const r = parseDxf(broken);
    expect(r.entities).toHaveLength(4);
    expect(r.warnings.join(" ")).toContain("SKETCHOR");
    expect(r.constraints).toEqual([]);
    // the plain GROUP objects are the fallback
    expect(r.groups.map((g) => g.name).sort()).toEqual(["Inner", "Outer"]);
  });
});

describe("foreign DXF GROUP objects", () => {
  const dxf = [
    "0", "SECTION", "2", "ENTITIES",
    "0", "LINE", "5", "A1", "8", "0", "10", "0", "20", "0", "11", "5", "21", "0",
    "0", "LINE", "5", "A2", "8", "0", "10", "0", "20", "1", "11", "5", "21", "1",
    "0", "LINE", "5", "A3", "8", "0", "10", "0", "20", "2", "11", "5", "21", "2",
    "0", "ENDSEC",
    "0", "SECTION", "2", "OBJECTS",
    "0", "DICTIONARY", "5", "C", "3", "ACAD_GROUP", "350", "D",
    "0", "DICTIONARY", "5", "D", "3", "Frame", "350", "G1", "3", "*A1", "350", "G2",
    "0", "GROUP", "5", "G1", "300", "", "70", "0", "71", "1", "340", "A1", "340", "A2",
    "0", "GROUP", "5", "G2", "70", "1", "340", "A2", "340", "A3",
    "0", "ENDSEC", "0", "EOF",
  ].join("\n");

  it("imports named groups, skips anonymous ones", () => {
    const r = parseDxf(dxf);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].name).toBe("Frame");
    expect(r.groups[0].members).toHaveLength(2);
    for (const m of r.groups[0].members) expect(r.entities.some((e) => e.id === m)).toBe(true);
  });
});

describe("sketchorData helpers", () => {
  it("chunks and decodes the JSON blob, escaping non-ASCII", () => {
    const data = { v: 1 as const, params: [{ name: "Ширина", value: "x".repeat(2500) }] };
    const chunks = encodeDocData(data);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join("")).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeDocData(chunks)).toEqual(data);
    expect(decodeDocData(["not json"])).toBeNull();
    expect(decodeDocData(['{"v":2}'])).toBeNull();
  });

  it("reads legacy name-only and ignores other applications' XDATA", () => {
    const p = (code: number, value: string) => ({ code, value });
    expect(parseEntityXdata([p(1001, "SKETCHOR"), p(1000, "L7")])).toEqual({ name: "L7" });
    expect(parseEntityXdata([p(1001, "OTHER"), p(1000, "id=zzz")])).toEqual({});
  });
});
