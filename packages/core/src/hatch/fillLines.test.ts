/**
 * Why this matters: the fill engine decides what ink a hatch puts on paper. A
 * wrong island rule, a dash that restarts at an island, or a pattern that
 * hangs the UI on a big region are the hatch failures drafters notice first
 * (and the ones LibreCAD is known for). Ink length ≈ area / spacing is the
 * property that catches a missed or doubled line without pinning coordinates.
 */
import { describe, expect, it } from "vitest";
import type { HatchEntity, PatternFamily } from "../entities";
import "../kinds/builtin";
import { hatchFill, hatchFillCached, MAX_SEGMENTS, segmentCount, type HatchFill } from "./fillLines";
import { loopFromCircle, loopFromPoints } from "./loops";
import { parsePat, writePat } from "./pat";
import { registerPattern, unregisterPattern } from "./registry";

const sq = (x: number, y: number, s: number) => loopFromPoints([
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
]);

const fam = (over: Partial<PatternFamily> = {}): PatternFamily => ({ angle: 0, origin: { x: 0, y: 0 }, offset: { x: 0, y: 1 }, dashes: [], ...over });

const hatch = (families: PatternFamily[], over: Partial<HatchEntity> = {}, paint: Partial<Extract<HatchEntity["paint"], { kind: "pattern" }>> = {}): HatchEntity => ({
  id: "h",
  type: "hatch",
  loops: [sq(0, 0, 10)],
  paint: { kind: "pattern", name: "T", scale: 1, angle: 0, def: families, ...paint },
  style: "normal",
  ...over,
});

const length = (f: HatchFill): number => {
  let s = 0;
  for (let i = 0; i < f.segments.length; i += 4) s += Math.hypot(f.segments[i + 2] - f.segments[i], f.segments[i + 3] - f.segments[i + 1]);
  return s;
};

describe("parsePat / writePat", () => {
  const text = `; a comment
*TEST1, first pattern
0, 0,0, 0,3.175
45, 0,0, 4.4901,4.4901, 6.35, -1.5875, 0, -1.5875 ; dashes and a dot
*TEST2
90, 1, 2, 3, 4
`;

  it("reads names, descriptions, families and dashes", () => {
    const { patterns, issues } = parsePat(text);
    expect(issues).toEqual([]);
    expect(patterns.map((p) => p.name)).toEqual(["TEST1", "TEST2"]);
    expect(patterns[0].description).toBe("first pattern");
    expect(patterns[0].families).toHaveLength(2);
    expect(patterns[0].families[1]).toEqual({ angle: 45, origin: { x: 0, y: 0 }, offset: { x: 4.4901, y: 4.4901 }, dashes: [6.35, -1.5875, 0, -1.5875] });
    expect(patterns[1].families[0].origin).toEqual({ x: 1, y: 2 });
  });

  it("round-trips through writePat", () => {
    const a = parsePat(text).patterns;
    expect(parsePat(writePat(a)).patterns).toEqual(a);
  });

  it("never throws on malformed input and reports what it skipped", () => {
    for (const bad of ["", "*", "0,0,0,0,1", "*X\nnot, numbers, at, all, here", "*X\n1,2,3", "*A\n*B\n0,0,0,0,1", "\u0000\u0001*Q,\n0 0 0 0 1", "*X\n0,0,0,NaN,1"]) {
      const r = parsePat(bad);
      expect(Array.isArray(r.patterns)).toBe(true);
    }
    const r = parsePat("*A\n*B\n0,0,0,0,1\nstray 1,2");
    expect(r.patterns.map((p) => p.name)).toEqual(["B"]);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
    expect(parsePat("0,0,0,0,1").issues[0].message).toMatch(/before any/);
  });

  it("accepts whitespace separated numbers and CRLF", () => {
    const r = parsePat("*W, ws\r\n0 0 0 0 2\r\n");
    expect(r.patterns[0].families[0].offset).toEqual({ x: 0, y: 2 });
  });
});

describe("hatchFill", () => {
  it("covers a square with ink = area / spacing, at 0 and 45 degrees", () => {
    for (const angle of [0, 45, 90, 17]) {
      const f = hatchFill(hatch([fam({ angle })]));
      expect(length(f)).toBeGreaterThan(88);
      expect(length(f)).toBeLessThan(112);
    }
  });

  it("scale and the hatch angle act on spacing and direction", () => {
    const base = length(hatchFill(hatch([fam()])));
    expect(length(hatchFill(hatch([fam()], {}, { scale: 2 })))).toBeCloseTo(base / 2, -1);
    const vertical = hatchFill(hatch([fam()], {}, { angle: 90 }));
    for (let i = 0; i < vertical.segments.length; i += 4) expect(vertical.segments[i]).toBeCloseTo(vertical.segments[i + 2], 4);
  });

  it("island styles: normal alternates, outer stops at the first island, ignore paints through", () => {
    const loops = [sq(0, 0, 10), sq(3, 3, 4), sq(4, 4, 2)];
    const ink = (style: HatchEntity["style"]) => length(hatchFill(hatch([fam({ offset: { x: 0, y: 0.5 } })], { loops, style })));
    // 10x10 = 100, island 16, inner 4 → spacing 0.5 doubles the ink per area
    expect(ink("normal")).toBeCloseTo((100 - 16 + 4) * 2, -1);
    expect(ink("outer")).toBeCloseTo((100 - 16) * 2, -1);
    expect(ink("ignore")).toBeCloseTo(100 * 2, -1);
  });

  it("a circle boundary gets pi r^2 / spacing of ink", () => {
    const f = hatchFill(hatch([fam({ angle: 30 })], { loops: [loopFromCircle({ x: 0, y: 0 }, 20)] }));
    expect(length(f)).toBeGreaterThan(Math.PI * 400 * 0.99);
    expect(length(f)).toBeLessThan(Math.PI * 400 * 1.01);
  });

  it("dashes keep their phase across an island and total the ink fraction", () => {
    const f = hatchFill(hatch([fam({ offset: { x: 0, y: 2 }, dashes: [2, -1] })], { loops: [sq(0, 0, 12), sq(4, 4, 4)] }));
    // every stroke starts on the 3-unit cycle of its line (anchor 0) unless clipped by the boundary
    for (let i = 0; i < f.segments.length; i += 4) {
      const t0 = f.segments[i];
      const t1 = f.segments[i + 2];
      const len = t1 - t0;
      expect(len).toBeLessThanOrEqual(2 + 1e-4);
      const onCycle = Math.abs(((t0 % 3) + 3) % 3) < 1e-4 || Math.abs(((t0 % 3) + 3) % 3 - 3) < 1e-4;
      const clipped = Math.abs(t0 - 0) < 1e-4 || Math.abs(t0 - 4) < 1e-4 || Math.abs(t0 - 8) < 1e-4 || Math.abs(t0 - 12) < 1e-4 || Math.abs(t1 - 12) < 1e-4 || Math.abs(t1 - 4) < 1e-4 || Math.abs(t1 - 8) < 1e-4;
      expect(onCycle || clipped).toBe(true);
    }
    const solid = length(hatchFill(hatch([fam({ offset: { x: 0, y: 2 } })], { loops: [sq(0, 0, 12), sq(4, 4, 4)] })));
    expect(length(f) / solid).toBeGreaterThan(0.6);
    expect(length(f) / solid).toBeLessThan(0.74);
  });

  it("zero-length dashes become dots", () => {
    const f = hatchFill(hatch([fam({ offset: { x: 0, y: 2 }, dashes: [0, -2] })]));
    expect(segmentCount(f)).toBe(0);
    expect(f.dots.length / 2).toBeGreaterThan(20);
  });

  it("a double hatch adds the perpendicular family", () => {
    const single = length(hatchFill(hatch([fam()])));
    expect(length(hatchFill(hatch([fam()], {}, { double: true })))).toBeCloseTo(single * 2, -2);
  });

  it("an unknown pattern name is reported, a registered one resolves", () => {
    const miss = hatchFill({ ...hatch([]), paint: { kind: "pattern", name: "NOPE-X", scale: 1, angle: 0 } });
    expect(miss.unknownPattern).toBe(true);
    expect(segmentCount(miss)).toBe(0);
    registerPattern({ name: "UNIT-TEST-PAT", description: "", families: [fam()] });
    const hit = hatchFill({ ...hatch([]), paint: { kind: "pattern", name: "unit-test-pat", scale: 1, angle: 0 } });
    unregisterPattern("UNIT-TEST-PAT");
    expect(hit.unknownPattern).toBe(false);
    expect(length(hit)).toBeGreaterThan(88);
  });

  it("degenerate input yields nothing and does not hang: zero spacing, no loops, tiny region, non-positive scale", () => {
    expect(segmentCount(hatchFill(hatch([fam({ offset: { x: 1, y: 0 } })])))).toBe(0);
    expect(segmentCount(hatchFill(hatch([fam()], { loops: [] })))).toBe(0);
    expect(segmentCount(hatchFill(hatch([fam()], { loops: [sq(0, 0, 1e-6)] })))).toBeLessThanOrEqual(2);
    expect(segmentCount(hatchFill(hatch([fam()], {}, { scale: 0 })))).toBe(0);
    expect(segmentCount(hatchFill(hatch([fam()], {}, { scale: -1 })))).toBe(0);
    expect(segmentCount(hatchFill(hatch([fam({ offset: { x: 0, y: -1 } })])))).toBeGreaterThan(5);
  });

  it("the density guard summarises a runaway pattern instead of generating it", () => {
    const f = hatchFill(hatch([fam({ offset: { x: 0, y: 0.0001 } })], { loops: [sq(0, 0, 1000)] }));
    expect(f.truncated).toBe(true);
    expect(f.segments.length).toBe(0);
    expect(f.inkPerArea).toBeCloseTo(10000, -1);
    expect(f.minSpacing).toBeCloseTo(0.0001, 9);
    expect(MAX_SEGMENTS).toBe(200_000);
  });

  it("solid and gradient paints have no strokes; the cache returns the same result per entity object", () => {
    const solid: HatchEntity = { ...hatch([]), paint: { kind: "solid", color: "#fff" } };
    expect(segmentCount(hatchFill(solid))).toBe(0);
    const h = hatch([fam()]);
    expect(hatchFillCached(h)).toBe(hatchFillCached(h));
    expect(hatchFillCached({ ...h })).not.toBe(hatchFillCached(h));
  });

  it("performance: a 1 m x 1 m region of 45-degree lines at 3.175 mm generates quickly", () => {
    const h = hatch([fam({ angle: 45, offset: { x: 0, y: 3.175 } })], { loops: [sq(0, 0, 1000), sq(100, 100, 300)] });
    const t = performance.now();
    const f = hatchFill(h);
    const ms = performance.now() - t;
    expect(segmentCount(f)).toBeGreaterThan(400);
    expect(ms).toBeLessThan(1000);
  });
});
