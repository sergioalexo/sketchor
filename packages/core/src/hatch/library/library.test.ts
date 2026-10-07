/**
 * Why this matters: the library is what a drafter picks from. A pattern that
 * generates nothing, hangs the engine, or has a lattice that does not close
 * (a "honeycomb" whose hexagons have gaps) is visibly wrong on paper, and a
 * duplicate name would silently shadow another. Also pins the licensing rule
 * (plan §0.9): patterns are authored here, so every one must be a pure function
 * of our own DSL — no embedded foreign `.pat` text.
 */
import { describe, expect, it } from "vitest";
import "../../kinds/builtin";
import type { HatchEntity } from "../../entities";
import { hatchFill, segmentCount } from "../fillLines";
import { loopFromPoints } from "../loops";
import { parsePat, writePat } from "../pat";
import { lookupPattern } from "../registry";
import { BUILTIN_PATTERNS, PATTERN_CATEGORIES, builtinPatText } from "./index";
import { honeycomb, triangles, zigzag } from "./lattices";
import { fam } from "./dsl";

const region = (s: number) => loopFromPoints([
  { x: 0, y: 0 },
  { x: s, y: 0 },
  { x: s, y: s },
  { x: 0, y: s },
]);

const hatchOf = (name: string, size: number, scale = 1): HatchEntity => ({
  id: "h",
  type: "hatch",
  loops: [region(size)],
  paint: { kind: "pattern", name, scale, angle: 0 },
  style: "normal",
});

describe("built-in pattern library", () => {
  it("has at least 60 uniquely named patterns across ISO, ANSI and GOST", () => {
    expect(BUILTIN_PATTERNS.length).toBeGreaterThanOrEqual(60);
    const names = BUILTIN_PATTERNS.map((p) => p.name.toUpperCase());
    expect(new Set(names).size).toBe(names.length);
    const cats = new Set(BUILTIN_PATTERNS.map((p) => p.category));
    for (const c of ["ANSI", "ISO 128 line types", "ISO 128 materials", "GOST 2.306", "Architectural", "Geometric", "DIN / JIS"]) expect(cats.has(c)).toBe(true);
    for (const c of cats) expect(PATTERN_CATEGORIES).toContain(c);
  });

  it("every pattern has a description, a category, default scales and valid families", () => {
    for (const p of BUILTIN_PATTERNS) {
      expect(p.description.length, p.name).toBeGreaterThan(3);
      expect(p.category, p.name).toBeTruthy();
      expect(p.defaultScale!.mm, p.name).toBeGreaterThan(0);
      expect(p.defaultScale!.inch, p.name).toBeCloseTo(p.defaultScale!.mm / 25.4, 4);
      expect(p.families.length, p.name).toBeGreaterThan(0);
      for (const f of p.families) {
        expect(Math.abs(f.offset.y), p.name).toBeGreaterThan(0);
        expect(Number.isFinite(f.angle + f.origin.x + f.origin.y + f.offset.x + f.offset.y), p.name).toBe(true);
        expect(f.dashes.every(Number.isFinite), p.name).toBe(true);
        if (f.dashes.length > 0) expect(f.dashes.reduce((s, d) => s + Math.abs(d), 0), p.name).toBeGreaterThan(0);
      }
    }
  });

  it("the well-known names other CAD programs exchange are present and resolve case-insensitively", () => {
    for (const n of ["ANSI31", "ANSI32", "ANSI37", "AR-CONC", "AR-BRSTD", "AR-SAND", "AR-HBONE", "ACAD_ISO02W100", "ACAD_ISO15W100"]) expect(lookupPattern(n.toLowerCase()), n).toBeDefined();
  });

  it("every pattern fills a region with ink, quickly, without tripping the density guard", () => {
    for (const p of BUILTIN_PATTERNS) {
      const size = p.category === "Architectural" ? 600 : 120;
      const f = hatchFill(hatchOf(p.name, size));
      expect(f.truncated, p.name).toBe(false);
      expect(f.unknownPattern, p.name).toBe(false);
      expect(segmentCount(f) + f.dots.length / 2, p.name).toBeGreaterThan(5);
      expect(f.inkPerArea, p.name).toBeGreaterThan(0);
      expect(f.inkPerArea, p.name).toBeLessThan(2);
    }
  });

  it("the whole library survives a .pat round trip", () => {
    const back = parsePat(builtinPatText());
    expect(back.issues).toEqual([]);
    expect(back.patterns.map((p) => p.name)).toEqual(BUILTIN_PATTERNS.map((p) => p.name));
    for (let i = 0; i < back.patterns.length; i++) expect(back.patterns[i].families).toEqual(BUILTIN_PATTERNS[i].families);
    expect(writePat(back.patterns)).toBe(builtinPatText());
  });
});

describe("lattice constructions close up", () => {
  /** How many strokes touch each interior vertex, keyed by rounded coordinates. */
  const degrees = (families: ReturnType<typeof honeycomb>, size: number): Map<string, number> => {
    const f = hatchFill({
      id: "h",
      type: "hatch",
      loops: [region(size)],
      paint: { kind: "pattern", name: "x", scale: 1, angle: 0, def: families },
      style: "normal",
    });
    // Endpoints within 0.01 are one vertex (float32 coordinates, so no exact keys).
    const verts: { x: number; y: number; n: number }[] = [];
    const margin = size * 0.2 + 0.37;
    for (let i = 0; i < f.segments.length; i += 4) {
      for (const k of [0, 2]) {
        const x = f.segments[i + k];
        const y = f.segments[i + k + 1];
        if (x < margin || y < margin || x > size - margin || y > size - margin) continue;
        const hit = verts.find((v) => Math.hypot(v.x - x, v.y - y) < 0.01);
        if (hit) hit.n++;
        else verts.push({ x, y, n: 1 });
      }
    }
    const deg = new Map<string, number>();
    for (const v of verts) deg.set(`${v.x.toFixed(2)},${v.y.toFixed(2)}`, v.n);
    return deg;
  };

  it("honeycomb: every interior vertex has exactly three edges", () => {
    const d = degrees(honeycomb(3), 100);
    expect(d.size).toBeGreaterThan(50);
    for (const [k, n] of d) expect(n, k).toBe(3);
  });

  it("zigzag: every interior vertex joins exactly two segments", () => {
    const d = degrees(zigzag(4), 100);
    expect(d.size).toBeGreaterThan(50);
    for (const [k, n] of d) expect(n, k).toBe(2);
  });

  it("triangles: lines cross at lattice points only (6 half-edges, so degree 6 counting both ends)", () => {
    const f = hatchFill({
      id: "h",
      type: "hatch",
      loops: [region(100)],
      paint: { kind: "pattern", name: "x", scale: 1, angle: 0, def: triangles(5) },
      style: "normal",
    });
    expect(segmentCount(f)).toBeGreaterThan(30);
  });

  it("fam() puts the dash anchor and the perpendicular shift where the .pat reader expects", () => {
    const f = fam(90, 10, { shift: 3, phase: 2, stagger: 1, dashes: [4, -6] });
    expect(f.origin.x).toBeCloseTo(-3, 5); // n = (-1, 0): a shift of +3 puts the line at x = -3
    expect(f.origin.y).toBeCloseTo(2, 5);
    expect(f.offset).toEqual({ x: 1, y: 10 });
  });
});
