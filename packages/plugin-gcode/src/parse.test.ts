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
});
