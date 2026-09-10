import { describe, expect, it } from "vitest";
import { gcodeToEntities } from "./parse";

/** Pull the first added polyline's entity out of the result. */
function firstPoly(text: string, opts?: Parameters<typeof gcodeToEntities>[1]) {
  const { commands } = gcodeToEntities(text, opts);
  const c = commands.find((x) => x.type === "add-entity");
  if (!c || c.type !== "add-entity" || c.entity.type !== "polyline") throw new Error("no polyline");
  return c.entity;
}

describe("gcodeToEntities", () => {
  it("turns G1 moves into one polyline on the G-code layer", () => {
    const p = firstPoly("G21 G90\nG0 X0 Y0\nG1 X10 Y0\nG1 X10 Y10\nG1 X0 Y10");
    expect(p.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(p.layer).toBe("G-code");
  });

  it("scales inch programs (G20) to millimetres", () => {
    const p = firstPoly("G20 G90\nG1 X1 Y0\nG1 X1 Y1");
    expect(p.points[1].x).toBeCloseTo(25.4);
    expect(p.points[2].y).toBeCloseTo(25.4);
  });

  it("honours G91 incremental distance mode", () => {
    const p = firstPoly("G21 G91\nG1 X5\nG1 X5\nG1 Y5");
    expect(p.points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
    ]);
  });

  it("gives a G3 (CCW) quarter-arc a positive ~0.414 bulge from I/J", () => {
    // start (10,0), end (0,10), centre at origin, CCW quarter turn.
    const p = firstPoly("G21 G90\nG0 X10 Y0\nG3 X0 Y10 I-10 J0");
    expect(p.bulges?.[0]).toBeCloseTo(Math.tan(Math.PI / 8), 4); // ≈ 0.4142
  });

  it("gives a G2 (CW) arc a negative bulge", () => {
    const p = firstPoly("G21 G90\nG0 X0 Y0\nG2 X10 Y0 R5");
    expect(p.bulges?.[0]).toBeLessThan(0);
  });

  it("selects the major arc for a negative R", () => {
    const minor = firstPoly("G21 G90\nG0 X0 Y0\nG2 X10 Y0 R6");
    const major = firstPoly("G21 G90\nG0 X0 Y0\nG2 X10 Y0 R-6");
    expect(Math.abs(major.bulges![0])).toBeGreaterThan(Math.abs(minor.bulges![0]));
  });

  it("strips ( ) and ; comments", () => {
    const p = firstPoly("(profile) G21 G90\nG1 X10 Y0 ; rapid over\nG1 X10 Y10");
    expect(p.points).toHaveLength(3);
  });

  it("warns on an unsupported plane", () => {
    const { warnings } = gcodeToEntities("G18\nG1 X10");
    expect(warnings.some((w) => /plane/i.test(w))).toBe(true);
  });

  it("keeps rapids out unless asked", () => {
    const without = gcodeToEntities("G0 X10\nG1 Y10\nG0 X0");
    const withR = gcodeToEntities("G0 X10\nG1 Y10\nG0 X0", { includeRapids: true });
    expect(withR.commands.length).toBeGreaterThan(without.commands.length);
    expect(without.stats.rapids).toBe(2);
  });

  /**
   * The unit is the one thing that silently ruins an import: document
   * coordinates are millimetres, so reading an inch program as mm lands the part
   * at 1/25th size with no error anywhere. Plenty of posts never emit G20/G21 at
   * all, so "the file didn't say" has to be visible and overridable.
   */
  describe("units", () => {
    const SQUARE = "G90\nG1 X1 Y0\nG1 X1 Y1";

    it("reports where the unit came from when the program declares it", () => {
      expect(gcodeToEntities("G20 " + SQUARE).stats).toMatchObject({ unit: "in", unitSource: "declared", scale: 25.4 });
      expect(gcodeToEntities("G21 " + SQUARE).stats).toMatchObject({ unit: "mm", unitSource: "declared", scale: 1 });
    });

    it("assumes millimetres, and says so, when the program never declares a unit", () => {
      const { stats, warnings } = gcodeToEntities(SQUARE);
      expect(stats).toMatchObject({ unit: "mm", unitSource: "assumed" });
      expect(warnings.some((w) => /never says G20 or G21/.test(w))).toBe(true);
    });

    it("assumes the caller's unit instead — an inch drawing gets inch geometry", () => {
      const p = firstPoly(SQUARE, { assume: "in" });
      expect(p.points[1]).toEqual({ x: 25.4, y: 0 });
      expect(gcodeToEntities(SQUARE, { assume: "in" }).stats.unitSource).toBe("assumed");
    });

    it("does not second-guess a program that declares its unit", () => {
      // `assume` is only a fallback: G21 still wins over an inch-leaning caller.
      const p = firstPoly("G21 " + SQUARE, { assume: "in" });
      expect(p.points[1]).toEqual({ x: 1, y: 0 });
    });

    it("forces the unit over what the program declares, and warns about the disagreement", () => {
      const { commands, stats, warnings } = gcodeToEntities("G21 " + SQUARE, { unit: "in" });
      const first = commands.find((c) => c.type === "add-entity");
      if (first?.type !== "add-entity" || first.entity.type !== "polyline") throw new Error("no polyline");
      expect(first.entity.points[1]).toEqual({ x: 25.4, y: 0 });
      expect(stats).toMatchObject({ unit: "in", unitSource: "forced" });
      expect(warnings.some((w) => /declares G21/.test(w))).toBe(true);
    });

    it("stays silent when the forced unit agrees with the program", () => {
      const { warnings, stats } = gcodeToEntities("G20 " + SQUARE, { unit: "in" });
      expect(warnings).toEqual([]);
      expect(stats.unitSource).toBe("forced");
    });

    it("reports the unit the geometry was built with, not wherever the modal state ended", () => {
      // A trailing G21 reset is common; it must not relabel an inch program.
      const { stats } = gcodeToEntities("G20 " + SQUARE + "\nG21");
      expect(stats.unit).toBe("in");
    });

    it("scales arc centres and R-word radii with the coordinates", () => {
      const ij = firstPoly("G20 G90\nG0 X1 Y0\nG3 X0 Y1 I-1 J0");
      const r = firstPoly("G20 G90\nG0 X0 Y0\nG2 X1 Y0 R0.5");
      // A quarter-turn of a 1in radius, and a half-turn across a 1in chord.
      expect(ij.points[1]).toEqual({ x: 0, y: 25.4 });
      expect(Math.abs(ij.bulges?.[0] ?? 0)).toBeCloseTo(Math.tan(Math.PI / 8), 6);
      expect(r.points[1].x).toBeCloseTo(25.4, 6);
      expect(Math.abs(r.bulges?.[0] ?? 0)).toBeCloseTo(1, 6);
    });
  });
});
